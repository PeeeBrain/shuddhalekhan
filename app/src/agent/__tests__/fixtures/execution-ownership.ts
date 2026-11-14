import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mock } from 'bun:test';
import type { ModelMessage } from 'ai';
import type { AgentRuntimeCallbacks } from '../../runtime';
import type { AppConfig } from '../../../types/ipc';
import type { SidecarEvent } from '../../protocol';
import * as protocol from '../../protocol';

const input = new PassThrough();
Object.defineProperty(process, 'stdin', { value: input });
const events: SidecarEvent[] = [];
const audit: string[] = [];
const changes = new Set<() => void>();
const changed = () => { for (const listener of [...changes]) listener(); };
function until(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise(resolve => {
    const listener = () => { if (predicate()) { changes.delete(listener); resolve(); } };
    changes.add(listener);
  });
}
const runs: Array<{
  signal: AbortSignal; callbacks: AgentRuntimeCallbacks; history: ModelMessage[];
  resolve: (messages: ModelMessage[] | null) => void;
}> = [];
const closed = new Set<number>();
mock.module('../../audit', () => ({ AgentAuditStore: class {
  record(_runId: string, event: string) { audit.push(event); }
  close() {}
} }));
mock.module('../../mcp-registry', () => ({ McpRegistry: class {
  async updateConfig() {}
  async settle() { return { connected: 0, enabled: 0 }; }
  createRunSnapshot() {
    const index = runs.length;
    return { tools: {}, close: async () => { closed.add(index); changed(); } };
  }
  async close() {}
} }));
mock.module('../../runtime', () => ({ runAgent: (
  _runId: string, _transcript: string, _config: AppConfig, _tools: unknown,
  signal: AbortSignal, callbacks: AgentRuntimeCallbacks, _apiKey: string | undefined,
  _context: unknown, history: ModelMessage[],
) => new Promise<ModelMessage[] | null>(resolve => {
  runs.push({ signal, callbacks, history, resolve });
  callbacks.onAudit?.('run_started');
  changed();
}) }));
mock.module('../../protocol', () => ({ ...protocol, logSidecar() {}, writeJsonLine: (event: SidecarEvent) => {
  events.push(event);
  changed();
} }));
await import('../../index');
const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
const provider = { baseUrl: 'http://localhost:11434/v1', model: 'fixture', apiKeyEnvVar: '', auth: 'none' as const };
send({ type: 'config:update', config: { agent: { enabled: true, provider, mcpServers: [] } } });
const start = () => send({ type: 'agent:start', agentRunId: 'conversation', transcript: 'Command.', continueFrom: 'conversation' });
start();
await until(() => runs.length === 1);
const old = runs[0];
start();
await until(() => runs.length === 2);
const current = runs[1];
assert.equal(old.signal.aborted, true);
assert.equal(current.signal.aborted, false);
const eventCount = events.length;
old.callbacks.onStatus('Stale status');
old.callbacks.onFailed('Stale failure');
old.callbacks.onCompleted('Stale answer', [], []);
old.callbacks.onMemoryStatus?.('Stale memory');
assert.equal(events.length, eventCount, 'a replaced execution cannot publish into its reply with the same run id');
const request = { serverId: 'mail', toolName: 'send', modelToolName: 'mail__send', arguments: {} };
assert.equal((await old.callbacks.requestToolApproval(request)).approved, false);
const decision = current.callbacks.requestToolApproval(request);
await until(() => events.some(event => event.type === 'approval:requested'));
const approval = events.find(event => event.type === 'approval:requested');
assert.ok(approval?.type === 'approval:requested');
old.callbacks.onCancelled();
const auditCount = audit.length;
old.callbacks.onAudit?.('run_interrupted');
assert.equal(audit.length, auditCount, 'late old interruption cannot terminate the current audit turn');
send({ type: 'approval:decision', agentRunId: 'conversation', approvalId: approval.approvalId, decision: 'approved' });
assert.deepEqual(await decision, { approved: true });
const latestMessages: ModelMessage[] = [{ role: 'assistant', content: 'Latest answer' }];
current.callbacks.onCompleted('Latest answer', [], []);
current.resolve(latestMessages);
await until(() => closed.has(1));
old.resolve([{ role: 'assistant', content: 'Old answer' }]);
await until(() => closed.has(0));
start();
await until(() => runs.length === 3);
assert.deepEqual(runs[2].history, latestMessages, 'late completion cannot replace the current conversation history');
runs[2].callbacks.onCancelled();
runs[2].resolve(null);
await until(() => closed.has(2));
send({ type: 'sidecar:shutdown' });
await until(() => events.some(event => event.type === 'sidecar:shutdown-complete'));
console.log('Execution ownership contracts passed');
input.end();
