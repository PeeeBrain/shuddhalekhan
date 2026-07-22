import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';

const vi = { fn: mock, mock: mock.module };

const stdinWrite = vi.fn();
const childKill = vi.fn();
const stdout = new EventEmitter();
const stderr = new EventEmitter();
const child = Object.assign(new EventEmitter(), {
  stdin: { write: stdinWrite },
  stdout,
  stderr,
  killed: false,
  kill: childKill,
});
const spawn = vi.fn(() => child);

class MockInterface extends EventEmitter {
  close = vi.fn();
}

const stdoutLines = new MockInterface();
const createInterface = vi.fn(() => stdoutLines);

mock.module('child_process', () => ({ spawn }));
mock.module('readline', () => ({ createInterface }));

describe('JsonlProcessManager', () => {
  beforeEach(() => {
    stdinWrite.mockClear();
    childKill.mockClear();
    spawn.mockClear();
    createInterface.mockClear();
    stdoutLines.close.mockClear();
    stdoutLines.removeAllListeners();
    child.removeAllListeners();
    stdout.removeAllListeners();
    stderr.removeAllListeners();
    child.killed = false;
  });

  it('spawns a process, parses incoming JSONL, and serializes outgoing messages', async () => {
    const messages: unknown[] = [];
    const { JsonlProcessManager } = await import(`../jsonl-process-manager?test=${Date.now()}-1`) as typeof import('../jsonl-process-manager');
    const manager = new JsonlProcessManager<{ type: string }, { type: string }>({
      onMessage: (message: { type: string }) => messages.push(message),
    });

    manager.start({ command: 'worker.exe', args: ['--jsonl'], env: { TEST_ENV: '1' } });
    manager.send({ type: 'ping' });
    stdoutLines.emit('line', JSON.stringify({ type: 'pong' }));

    expect(spawn).toHaveBeenCalledWith('worker.exe', ['--jsonl'], expect.objectContaining({
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { TEST_ENV: '1' },
    }));
    expect(stdinWrite).toHaveBeenCalledWith(`${JSON.stringify({ type: 'ping' })}\n`);
    expect(messages).toEqual([{ type: 'pong' }]);
  });

  it('reports malformed JSONL and process exit without crashing', async () => {
    const malformed = vi.fn();
    const onExit = vi.fn();
    const { JsonlProcessManager } = await import(`../jsonl-process-manager?test=${Date.now()}-2`) as typeof import('../jsonl-process-manager');
    const manager = new JsonlProcessManager({ onMessage: vi.fn(), onMalformedMessage: malformed, onExit });

    manager.start({ command: 'worker.exe', args: [] });
    stdoutLines.emit('line', '{bad');
    child.emit('exit', 7, null);

    expect(malformed).toHaveBeenCalledWith('{bad', expect.any(SyntaxError));
    expect(stdoutLines.close).toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledWith(7, null);
  });
});
