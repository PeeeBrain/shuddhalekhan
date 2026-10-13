import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mock } from 'bun:test';
import * as sdk from 'ai';
import * as protocol from '../../protocol';
import type { SidecarEvent } from '../../protocol';

let controller = new AbortController();
let deadline = new AbortController();
let failure = () => {};
const providerError = Object.assign(new Error('Provider authentication failed.'), { statusCode: 401 });
mock.module('ai', () => ({ ...sdk, streamText: () => ({
  stream: (async function* () { failure(); yield { type: 'error', error: providerError }; })(),
}) }));
const timeout = AbortSignal.timeout;
AbortSignal.timeout = () => deadline.signal;
const { testAgentProvider } = await import('../../provider-test');
const profile = { baseUrl: 'http://localhost:11434/v1', model: 'local', apiKeyEnvVar: '', auth: 'none' as const };
failure = () => controller.abort();
assert.equal((await testAgentProvider(profile, controller.signal)).diagnostic?.kind, 'authentication');
controller = new AbortController();
failure = () => deadline.abort(new DOMException('Deadline expired.', 'TimeoutError'));
assert.equal((await testAgentProvider(profile, controller.signal)).diagnostic?.kind, 'authentication');
deadline = new AbortController();
failure = () => { controller.abort(); throw controller.signal.reason; };
assert.equal((await testAgentProvider(profile, controller.signal)).diagnostic?.kind, 'cancelled');
controller = new AbortController();
failure = () => {
  deadline.abort(new DOMException('Deadline expired.', 'TimeoutError'));
  controller.abort();
  throw deadline.signal.reason;
};
assert.equal((await testAgentProvider(profile, controller.signal)).diagnostic?.kind, 'timeout');
AbortSignal.timeout = timeout;

const input = new PassThrough();
Object.defineProperty(process, 'stdin', { value: input });
const events: SidecarEvent[] = [];
let completed = () => {};
mock.module('../../audit', () => ({ AgentAuditStore: class { record() {} close() {} } }));
mock.module('../../provider-test', () => ({ testAgentProvider: async () => { throw new Error('private-test-key'); } }));
mock.module('../../protocol', () => ({ ...protocol, logSidecar() {}, writeJsonLine: (message: SidecarEvent) => {
  events.push(message);
  if (message.type === 'provider:test-result') queueMicrotask(() => queueMicrotask(completed));
} }));
await import('../../index');
for (const requestId of ['failure-1', 'failure-2']) {
  const result = new Promise<void>(resolve => { completed = resolve; });
  input.write(`${JSON.stringify({ type: 'provider:test', requestId, provider: profile })}\n`);
  await result;
  const response = events.find(message => message.type === 'provider:test-result' && message.requestId === requestId);
  assert.ok(response?.type === 'provider:test-result');
  assert.equal(response.result.diagnostic?.kind, 'provider');
}
assert.ok(!JSON.stringify(events).includes('private-test-key'));
input.end();
console.log('Provider failure contracts passed');
