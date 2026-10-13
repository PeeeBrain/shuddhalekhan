import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { runAgent, type AgentRuntimeCallbacks } from '../../runtime';
import { AgentMemoryStore } from '../../../main/agent-memory';
import { AgentSkillStore } from '../../../shared/agent-skills';
import { LOAD_SKILL_TOOL, READ_SKILL_RESOURCE_TOOL } from '../../skills';
import type { AgentRunContext } from '../../../shared/agent-context';

const directory = mkdtempSync(join(tmpdir(), 'shuddha-runtime-context-'));
const skills = new AgentSkillStore(join(directory, 'skills'));
const memory = new AgentMemoryStore(directory);
const bodySchema = z.object({ stream: z.boolean().optional(), messages: z.array(z.object({ role: z.string(), content: z.unknown() })) });
let requests: z.infer<typeof bodySchema>[] = [];
let mode: 'skills' | 'text' | 'invalid' | 'timeout' | 'cancel' = 'skills';
let controller = new AbortController();
const deadline = new AbortController();
const originalTimeout = AbortSignal.timeout;
AbortSignal.timeout = milliseconds => mode === 'timeout' && milliseconds === 10_000 ? deadline.signal : originalTimeout(milliseconds);
let approvals = 0;
let sends = 0;
let completed = 0;
let cancelled = 0;
const order: string[] = [];
const memoryOutcomes: string[] = [];
const config = { agent: { enabled: true, memoryEnabled: true, provider: { kind: 'openai-compatible' as const, baseUrl: 'http://localhost:9999/v1', model: 'fixture', apiKeyEnvVar: '', auth: 'none' as const }, mcpServers: [], disabledSkills: [] as string[] } };

globalThis.fetch = async (_input, init) => {
  const body = bodySchema.parse(JSON.parse(String(init?.body)));
  requests.push(body);
  if (!body.stream) {
    order.push('extract');
    if (mode === 'cancel') {
      controller.abort();
      throw new Error('cancelled');
    }
    if (mode === 'timeout') {
      deadline.abort(new DOMException('The memory request timed out.', 'TimeoutError'));
      throw deadline.signal.reason;
    }
    const content = mode === 'invalid' ? 'invalid output' : JSON.stringify({ updates: [{ previous: null, text: 'The user prefers Marathi.' }] });
    return Response.json({ id: 'memory-response', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  }
  const results = body.messages.filter(message => message.role === 'tool').length;
  let call: { name: string; arguments: string } | undefined;
  if (mode === 'skills' && results < 2) {
    call = results === 0 ? { name: LOAD_SKILL_TOOL, arguments: JSON.stringify({ name: 'email-style' }) }
      : { name: 'mail__send', arguments: '{}' };
  }
  const delta = call ? { tool_calls: [{ index: 0, id: `call-${results}`, type: 'function', function: call }] } : { content: 'Done.' };
  const event = (value: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'context-response', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
  return new Response(event(delta, null) + event({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};

const callbacks: AgentRuntimeCallbacks = {
  onStatus() {},
  onResponseDelta() { order.push('answer'); },
  onCompleted(response) { assert.equal(response, 'Done.'); completed += 1; order.push('complete'); },
  onFailed(error) { throw new Error(error); },
  onCancelled() { cancelled += 1; },
  requestToolApproval: async () => { approvals += 1; return { approved: true }; },
  commitMemory: async (revision, updates) => memory.commit(revision, updates),
  onMemoryStatus(status) { memoryOutcomes.push(status); },
};

const context = (): AgentRunContext => ({ skillsDirectory: skills.directory, memory: memory.snapshot() });
try {
  skills.save({ name: 'email-style', create: true, content: '---\nname: email-style\ndescription: Format emails.\n---\nKeep paragraphs short and use a friendly greeting.\n' });
  await runAgent('run-1', 'I prefer Marathi. Send an email.', config, {
    mail__send: tool({ description: 'Send an email.', inputSchema: z.object({}), needsApproval: true, execute: async () => { sends += 1; return 'Sent.'; } }),
  }, controller.signal, callbacks, undefined, context());
  assert.equal(approvals, 1);
  assert.equal(sends, 1);
  assert.equal(completed, 1);
  assert.equal(requests.length, 4); // Three task generations plus one memory extraction.
  assert.ok(!JSON.stringify(requests[0]).includes('friendly greeting'));
  assert.ok(JSON.stringify(requests[1]).includes('friendly greeting'));
  assert.ok(!JSON.stringify(requests.at(-1)).includes('friendly greeting'));
  assert.deepEqual(order.slice(-3), ['answer', 'extract', 'complete']);
  assert.equal(new AgentMemoryStore(directory).snapshot().facts[0].text, 'The user prefers Marathi.');

  mode = 'text';
  requests = [];
  config.agent.disabledSkills = ['email-style'];
  await runAgent('run-2', 'What language do I prefer?', config, {}, controller.signal, callbacks, undefined, context());
  assert.ok(JSON.stringify(requests[0]).includes('The user prefers Marathi.'));
  assert.ok(!JSON.stringify(requests[0]).includes('Format emails.'));
  assert.equal(memory.snapshot().facts.length, 1);

  config.agent.memoryEnabled = false;
  requests = [];
  await runAgent('run-3', 'Hello.', config, {}, controller.signal, callbacks, undefined, context());
  assert.equal(requests.length, 1);
  assert.ok(!JSON.stringify(requests[0]).includes('The user prefers Marathi.'));

  config.agent.memoryEnabled = true;
  mode = 'invalid';
  requests = [];
  const prior = memory.snapshot().revision;
  await runAgent('run-4', 'Hello.', config, {}, controller.signal, callbacks, undefined, context());
  assert.equal(requests.length, 2);
  assert.equal(completed, 4);
  assert.equal(memory.snapshot().revision, prior);
  assert.ok(memoryOutcomes.at(-1)?.includes('skipped'));

  mode = 'timeout';
  requests = [];
  await runAgent('run-timeout', 'Hello.', config, {}, controller.signal, callbacks, undefined, context());
  assert.equal(requests.length, 2);
  assert.equal(completed, 5);
  assert.equal(memory.snapshot().revision, prior);

  mode = 'cancel';
  controller = new AbortController();
  await runAgent('run-5', 'Hello.', config, {}, controller.signal, callbacks, undefined, context());
  assert.equal(cancelled, 1);
  assert.equal(completed, 5);
  assert.equal(memory.snapshot().revision, prior);

  // Resource reads require activation, and stay within that skill's folder.
  const { createSkillTools } = await import('../../skills');
  const skillTools = createSkillTools(skills.directory, [], new AbortController().signal, undefined).tools;
  const resource = skillTools[READ_SKILL_RESOURCE_TOOL];
  const load = skillTools[LOAD_SKILL_TOOL];
  if (!resource.execute || !load.execute) throw new Error('Missing skill tools.');
  const options = { toolCallId: 'direct-check', messages: [], context: {} };
  assert.ok(JSON.stringify(await resource.execute({ name: 'email-style', path: 'SKILL.md' }, options)).includes('Load the skill'));
  await load.execute({ name: 'email-style' }, options);
  assert.ok(JSON.stringify(await resource.execute({ name: 'email-style', path: '../agent-memory.md' }, options)).includes('error'));
  console.log('Agent context contracts passed');
} finally {
  AbortSignal.timeout = originalTimeout;
  rmSync(directory, { recursive: true, force: true });
}
