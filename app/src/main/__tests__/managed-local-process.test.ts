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

describe('Managed Local worker process', () => {
  it('reports a GPU worker that crashed after logging a CUDA allocation failure as out of memory', async () => {
    const child = new Child();
    electronMock.utilityProcess.fork.mockReturnValue(child);
    const worker = await startLocalRuntimeProcess({ model: 'granite', backend: 'cuda', modelPath: 'model', libraryPaths: [] });
    const errors: string[] = [];
    worker.on('message', message => errors.push((message as { message: string }).message));
    child.stderr.emit('data', Buffer.from('cudaMalloc failed: out of memory\n'));
    child.emit('exit', 134);
    expect(errors.some(isGpuOutOfMemory)).toBe(true);
  });
});
