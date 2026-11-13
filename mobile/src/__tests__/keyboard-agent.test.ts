import { expect, test } from 'bun:test';
import { MobileController, type Recorder } from '../controller';
import type { AgentActivityPort, AgentActivityUpdate } from '../agent-activity';
import type { KeyboardSessionEvent } from '../keyboard-session';
import { defaultSettings } from '../settings';
import { chatReply } from './model-stream';

const done: KeyboardSessionEvent = {
  endsAt: Date.now() + 60_000, requestId: 'keyboard-a', mode: 'agent', agentReady: true,
  phase: 'done', text: 'Find the next train.',
};

function setup(endpoint: string, start: AgentActivityPort['start'] = async () => ({ runId: 'native-run' })) {
  const updates: AgentActivityUpdate[] = [];
  const recorderCalls: string[] = [];
  const activity: AgentActivityPort = {
    start, resume: async () => {}, prepareApproval: async () => true, takeApprovalAction: async () => null,
    canContinueInBackground: async () => true,
    update: async update => { updates.push(update); }, recover: async () => null, clear: async () => {},
  };
  const recorder: Recorder = {
    requestPermission: async () => { recorderCalls.push('permission'); return true; },
    start: async () => { recorderCalls.push('start'); },
    stop: async () => { recorderCalls.push('stop'); return new Blob(); },
    discard: async () => { recorderCalls.push('discard'); },
  };
  const controller = new MobileController({ recorder, activity, fetch,
    loadSettings: async () => ({ ...defaultSettings, agentEnabled: true, agentProvider: 'openai-compatible',
      agentEndpoint: endpoint, allowInsecureHTTP: true }), saveSettings: async settings => settings,
  });
  return { controller, updates, recorderCalls };
}

function finished(controller: MobileController): Promise<void> {
  if (controller.getSnapshot().phase === 'idle') return Promise.resolve();
  return new Promise(resolve => {
    const unsubscribe = controller.subscribe(() => {
      if (controller.getSnapshot().phase === 'idle') { unsubscribe(); resolve(); }
    });
  });
}

// Protects actual keyboard-to-provider delivery, single-flight rejection and native result publishing.
// A UI-only handoff, an accidental second run, or recorder cleanup that disables the session mic fails it.
test('a background keyboard agent transcript runs once, rejects a busy command and publishes its answer without resetting audio', async () => {
  const requested = Promise.withResolvers<string>();
  const answer = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests++;
    requested.resolve(await request.text());
    await answer.promise;
    return chatReply('The next train is at 10.');
  } });
  try {
    const { controller, updates, recorderCalls } = setup(`http://127.0.0.1:${server.port}/v1/chat/completions`);
    await controller.initialize();
    await controller.handleKeyboardSession({ ...done, mode: 'dictate' });
    expect(requests).toBe(0);
    await controller.startRecording('dictation');
    expect(recorderCalls).toEqual([]);
    await controller.enterBackground();
    await controller.handleKeyboardSession(done);
    expect(await requested.promise).toContain('Find the next train.');
    await controller.handleKeyboardSession(done);
    await expect(controller.handleKeyboardSession({ ...done, requestId: 'keyboard-b' })).rejects.toThrow('busy');
    // Rejection/cancellation of B must never cancel the already running A.
    await controller.handleKeyboardSession({ ...done, requestId: 'keyboard-b', phase: 'failed', error: 'busy' });
    answer.resolve();
    await finished(controller);
    await controller.handleKeyboardSession(done);
    expect(requests).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', response: 'The next train is at 10.', error: null });
    expect(updates.at(-1)).toMatchObject({ runId: 'native-run', phase: 'completed', response: 'The next train is at 10.' });
    expect(recorderCalls).toEqual([]);
  } finally { answer.resolve(); await server.stop(true); }
});

test('cancelling a keyboard request during native admission prevents a late agent request', async () => {
  const started = Promise.withResolvers<{ runId: string }>();
  const { controller, updates, recorderCalls } = setup('https://agent.invalid/v1/chat/completions', () => started.promise);
  await controller.initialize();
  const admission = controller.handleKeyboardSession(done);
  const outcome = admission.then(() => null, (error: unknown) => error);
  await controller.handleKeyboardSession({ ...done, phase: 'cancelled' });
  started.resolve({ runId: 'native-run' });
  expect(await outcome).toBeInstanceOf(Error);
  await finished(controller);
  expect(updates.at(-1)).toMatchObject({ runId: 'native-run', phase: 'cancelled' });
  expect(recorderCalls).toEqual([]);
});

test('failed native admission rejects the keyboard handoff instead of claiming it was sent', async () => {
  const { controller, recorderCalls } = setup('https://agent.invalid/v1/chat/completions', async () => { throw new Error('not admitted'); });
  await controller.initialize();
  await expect(controller.handleKeyboardSession(done)).rejects.toThrow('could not start');
  await finished(controller);
  expect(controller.getSnapshot().error).toContain('could not start');
  expect(recorderCalls).toEqual([]);
});
