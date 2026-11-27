import { beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';
import { startLocalRuntimeProcess } from '../managed-local-process';
import { isGpuOutOfMemory } from '../managed-local-runtime';

class Child extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdout = new EventEmitter();
  postMessage() {}
  kill() { return true; }
}

installElectronMock();
beforeEach(resetElectronMock);

async function crash(stderr: (string | 'exit' | 'ready')[], model: 'granite' | 'parakeet' = 'granite') {
  const child = new Child();
  electronMock.utilityProcess.fork.mockReturnValue(child);
  const worker = await startLocalRuntimeProcess({ model, backend: 'cuda', modelPath: 'model', libraryPaths: [] });
  const messages: { kind: string; message?: string }[] = [];
  worker.on('message', message => messages.push(message as { kind: string; message?: string }));
  const exited = new Promise(resolve => worker.on('exit', resolve));
  for (const item of stderr) {
    if (item === 'exit') child.emit('exit', 134);
    else if (item === 'ready') child.emit('message', { kind: 'ready' });
    else child.stderr.emit('data', Buffer.from(item));
  }
  child.stderr.emit('end');
  await exited;
  return messages;
}
const outOfMemory = (messages: { message?: string }[]) => messages.some(({ message }) => message && isGpuOutOfMemory(message));

describe('Managed Local worker process', () => {
  it('reports a GPU worker crash as out of memory when the allocation failure arrives after exit', async () => {
    expect(outOfMemory(await crash(['exit', 'cudaMalloc failed: out of memory\n']))).toBe(true);
  });

  it('reports a GPU worker crash as out of memory after more than the kept diagnostic', async () => {
    expect(outOfMemory(await crash(['cudaMalloc failed: out of memory\n', 'x'.repeat(2048), 'exit']))).toBe(true);
  });

  it('never reports a crashed Parakeet GPU worker ready from CUDA placement logged after exit', async () => {
    const messages = await crash(['ready', 'exit', 'All nodes placed on [CUDAExecutionProvider]. Number of nodes: 500\n'], 'parakeet');
    expect(messages.map(({ kind }) => kind)).not.toContain('ready');
  });
});
