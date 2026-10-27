import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { MobileController, type Recorder } from '../controller';
import { parseAgentActivityLink, type AgentActivityPort, type AgentActivityUpdate } from '../agent-activity';
import { defaultSettings, type MobileSettings } from '../settings';

const recorder: Recorder = {
  requestPermission: async () => true, start: async () => {},
  stop: async () => new Blob(['audio']), discard: async () => {},
};

function activityPort(overrides: Partial<AgentActivityPort> = {}) {
  const updates: AgentActivityUpdate[] = [];
  const port: AgentActivityPort = {
    start: async () => ({ runId: 'run-1' }), resume: async () => {},
    canContinueInBackground: async () => true,
    update: async update => { updates.push(update); }, recover: async () => null, clear: async () => {},
    ...overrides,
  };
  return { port, updates };
}

function controllerFor(endpoint: string, activity: AgentActivityPort, mcpServers: MobileSettings['mcpServers'] = []) {
  return new MobileController({ recorder, fetch, activity, transcribeOnDevice: async () => 'A private spoken command.',
    loadSettings: async () => ({ ...defaultSettings, transcriptionSource: 'on-device', agentProvider: 'openai-compatible',
      agentEnabled: true, agentAuth: 'none', agentEndpoint: endpoint, allowInsecureHTTP: true, mcpServers }),
    saveSettings: async settings => settings,
  });
}

function when(controller: MobileController, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise(resolve => {
    const unsubscribe = controller.subscribe(() => { if (predicate()) { unsubscribe(); resolve(); } });
  });
}

describe('agent Live Activity lifecycle', () => {
  for (const outcome of ['granted', 'unavailable', 'expired'] as const) {
    test(`${outcome === 'granted' ? 'a' : 'an'} ${outcome} background task produces one correlated terminal state`, async () => {
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { entered.resolve(); return response.promise; } });
      const { port, updates } = activityPort({ canContinueInBackground: async () => outcome !== 'unavailable' });
      const controller = controllerFor(`http://127.0.0.1:${server.port}/chat`, port);
      try {
        await controller.initialize();
        await controller.startRecording('agent');
        const run = controller.stopRecording();
        await entered.promise;
        await controller.enterBackground();
        if (outcome === 'expired') {
          controller.agentRunStopped('old-run');
          expect(controller.getSnapshot().phase).toBe('running');
          controller.agentRunStopped('run-1');
        }
        response.resolve(Response.json({ choices: [{ message: { role: 'assistant', content: 'The answer.' } }] }));
        await run;
        expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', runId: 'run-1', response: outcome === 'granted' ? 'The answer.' : '' });
        const terminal = updates.filter(update => update.phase !== 'running' && update.phase !== 'awaitingApproval');
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({ runId: 'run-1', phase: outcome === 'granted' ? 'completed' : 'interrupted' });
        if (outcome === 'granted') expect(terminal[0]).toMatchObject({ response: 'The answer.', completedSteps: 1 });
        expect(JSON.stringify(updates)).not.toContain('private spoken command');
      } finally { controller.cancel(); response.resolve(new Response()); await server.stop(true); }
    });
  }

  test('foreground work still completes when the activity cannot start', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
      fetch: () => Response.json({ choices: [{ message: { role: 'assistant', content: 'Foreground answer.' } }] }),
    });
    try {
      const { port } = activityPort({ start: async () => { throw new Error('Native unavailable'); } });
      const controller = controllerFor(`http://127.0.0.1:${server.port}`, port);
      await controller.initialize();
      await controller.startRecording('agent');
      await controller.stopRecording();
      expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', response: 'Foreground answer.' });
      expect(controller.getSnapshot().activityNotice).toContain('Keep Shuddhalekhan open');
    } finally { await server.stop(true); }
  });
});

const rpc = z.object({ id: z.number().optional(), method: z.string() });
const modelRequest = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() });

async function withToolRun(run: (input: {
  controller: MobileController; native: AgentActivityPort; updates: AgentActivityUpdate[]; calls: () => number;
}) => Promise<void>, options: { rejectResume?: boolean; publication?: Promise<void> } = {}) {
  let modelCalls = 0;
  let calls = 0;
  const updates: AgentActivityUpdate[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/chat') {
      const body = modelRequest.parse(await request.json());
      modelCalls++;
      if (modelCalls > 2) return Response.json({ choices: [{ message: { role: 'assistant', content: 'Both tools finished.' } }] });
      const name = body.tools?.[0]?.function.name;
      if (!name) return new Response('No tool advertised', { status: 400 });
      return Response.json({ choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: `call-${modelCalls}`, type: 'function', function: { name, arguments: '{"private":"argument"}' } }],
      } }] });
    }
    if (request.method === 'DELETE') return new Response(null, { status: 202 });
    const body = rpc.parse(await request.json());
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id,
      result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
    });
    if (body.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: body.id,
      result: { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] },
    });
    if (body.method === 'tools/call') calls++;
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Tool done.' }] } });
  } });
  const { port } = activityPort({
    resume: async () => { if (options.rejectResume) throw new Error('Expired approval'); },
    update: async update => { updates.push(update); if (update.phase === 'awaitingApproval') await options.publication; },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const controller = controllerFor(`${base}/chat`, port, [{ id: 'tools', name: 'Tools', endpoint: `${base}/mcp`, token: '', enabled: true }]);
  let pending: Promise<void> | undefined;
  try {
    await controller.initialize();
    await controller.startRecording('agent');
    pending = controller.stopRecording();
    await when(controller, () => controller.getSnapshot().phase === 'awaitingApproval');
    await run({ controller, native: port, updates, calls: () => calls });
    await pending;
  } finally { controller.cancel(); await pending; await server.stop(true); }
}

test('approval waits survive backgrounding and stale activity actions cannot approve the next tool', async () => {
  const publication = Promise.withResolvers<void>();
  await withToolRun(async ({ controller, updates, calls }) => {
    const first = controller.getSnapshot().approval;
    if (!first) throw new Error('Expected first approval');
    await controller.enterBackground();
    expect(controller.getSnapshot().phase).toBe('awaitingApproval');
    publication.resolve();
    await controller.enterForeground();
    expect(controller.openActivity(`shuddhalekhan://agent?runId=${first.runId}&approvalId=${first.approvalId}&approved=true`)).toBe(true);
    expect(calls()).toBe(0);
    expect(controller.getSnapshot().approval).toEqual(first);
    await controller.resolveApproval({ ...first, approvalId: 'old-approval', approved: true });
    expect(calls()).toBe(0);
    await controller.resolveApproval({ ...first, approved: true });
    await when(controller, () => controller.getSnapshot().phase === 'awaitingApproval');
    const second = controller.getSnapshot().approval;
    if (!second) throw new Error('Expected second approval');
    expect(second.approvalId).not.toBe(first.approvalId);
    expect(controller.openActivity(`shuddhalekhan://agent?runId=${first.runId}&approvalId=${first.approvalId}`)).toBe(false);
    await controller.resolveApproval({ ...first, approved: true });
    expect(calls()).toBe(1);
    expect(controller.getSnapshot().approval).toEqual(second);
    await controller.resolveApproval({ ...second, approved: true });
    await when(controller, () => controller.getSnapshot().phase === 'idle');
    expect(calls()).toBe(2);
    expect(controller.getSnapshot().response).toBe('Both tools finished.');
    expect(updates.filter(update => update.phase === 'completed')).toHaveLength(1);
    expect(JSON.stringify(updates)).not.toContain('"private"');
  }, { publication: publication.promise });
});

test('an expired native approval cannot dispatch the tool even if its UI was still open', async () => {
  await withToolRun(async ({ controller, calls }) => {
    const approval = controller.getSnapshot().approval;
    if (!approval) throw new Error('Expected approval');
    await controller.resolveApproval({ ...approval, approved: true });
    await when(controller, () => controller.getSnapshot().phase === 'idle');
    expect(calls()).toBe(0);
    expect(controller.getSnapshot().status).toContain('Interrupted');
  }, { rejectResume: true });
});

test('restoring a single saved answer makes no network call and Clear removes it', async () => {
  let cleared = false;
  let networkCalls = 0;
  const { port } = activityPort({ recover: async () => ({ runId: 'finished-run', phase: 'completed', response: 'Saved final answer.' }),
    clear: async () => { cleared = true; },
  });
  const controller = new MobileController({ recorder, activity: port,
    fetch: Object.assign(async () => { networkCalls++; throw new Error('Recovery must not replay the run'); }, { preconnect: fetch.preconnect }),
    loadSettings: async () => defaultSettings, saveSettings: async settings => settings,
  });
  await controller.initialize();
  expect(networkCalls).toBe(0);
  expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', transcript: '', response: 'Saved final answer.', runId: 'finished-run' });
  expect(controller.openActivity('shuddhalekhan://agent?runId=finished-run')).toBe(true);
  await controller.clearResults();
  expect(cleared).toBe(true);
  expect(controller.getSnapshot()).toMatchObject({ response: '', runId: null });
});

test('activity links reject ambiguous IDs and unrelated routes', () => {
  for (const url of ['https://agent?runId=run-1', 'shuddhalekhan://agent/path?runId=run-1',
    'shuddhalekhan://agent?runId=run-1&runId=run-2', 'shuddhalekhan://agent?runId=run-1&approvalId=',
    'shuddhalekhan://agent?runId=run-1&approvalId=a&approvalId=b', 'shuddhalekhan://agent?runId=run%2F1']) {
    expect(parseAgentActivityLink(url)).toBeNull();
  }
});
