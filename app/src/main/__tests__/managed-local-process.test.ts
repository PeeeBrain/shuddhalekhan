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

async function crash(stderr: (string | 'exit')[]) {
  const child = new Child();
  electronMock.utilityProcess.fork.mockReturnValue(child);
  const worker = await startLocalRuntimeProcess({ model: 'granite', backend: 'cuda', modelPath: 'model', libraryPaths: [] });
  const errors: string[] = [];
  worker.on('message', message => errors.push((message as { message: string }).message));
  const exited = new Promise(resolve => worker.on('exit', resolve));
  for (const item of stderr) {
    if (item === 'exit') child.emit('exit', 134);
    else child.stderr.emit('data', Buffer.from(item));
  }
  child.stderr.emit('end');
  await exited;
  return errors.some(isGpuOutOfMemory);
}

describe('Managed Local worker process', () => {
  it('reports a GPU worker crash as out of memory when the allocation failure arrives after exit', async () => {
    expect(await crash(['exit', 'cudaMalloc failed: out of memory\n'])).toBe(true);
  });

  it('reports a GPU worker crash as out of memory after more than the kept diagnostic', async () => {
    expect(await crash(['cudaMalloc failed: out of memory\n', 'x'.repeat(2048), 'exit'])).toBe(true);
  });
});
