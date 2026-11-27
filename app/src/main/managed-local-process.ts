import { EventEmitter, once } from 'events';
import { join, delimiter } from 'path';
import type { LocalRuntime } from './managed-local-engine';
import { isGpuOutOfMemory } from './managed-local-runtime';

const GPU_OUT_OF_MEMORY_LOG = 'The worker logged a CUDA out of memory error.';

export async function startLocalRuntimeProcess(runtime: LocalRuntime) {
  const { utilityProcess } = await import('electron');
  const env = { ...process.env };
  if (runtime.libraryPaths) {
    // The loader reads this once at process start, so it must be in the worker's spawn environment.
    // Linux: LD_LIBRARY_PATH also wins over the app addon's RUNPATH, and cuDNN dlopens its sub-libraries by soname.
    const variable = process.platform === 'win32' ? 'PATH' : 'LD_LIBRARY_PATH';
    const inherited = process.env[variable];
    for (const name of Object.keys(env)) if (name.toUpperCase() === variable) delete env[name];
    env[variable] = [...runtime.libraryPaths, ...inherited ? [inherited] : []].join(delimiter);
  }
  const child = utilityProcess.fork(join(__dirname, 'local-stt.cjs'), [], {
    serviceName: 'Shuddhalekhan local speech recognition', env, stdio: 'pipe',
  });
  const events = new EventEmitter();
  let gpuVerified = runtime.backend !== 'cuda' || runtime.model !== 'parakeet';
  let readyReceived = false;
  let verificationTimeout: ReturnType<typeof setTimeout> | undefined;
  let diagnostic = '';
  // Kept apart from the 1 KiB diagnostic so later output cannot hide it.
  let outOfMemory = false;
  let exitCode: number | null = null;
  // ORT may silently substitute CPU. Require encoder node placement on CUDA, not just a provider request.
  child.stderr?.on('data', (chunk: Buffer) => {
    const output = diagnostic + chunk.toString();
    diagnostic = output.slice(-1024);
    if (runtime.backend === 'cuda' && isGpuOutOfMemory(output)) outOfMemory = true;
    // Output that arrives after exit is diagnostic only; a dead worker never becomes ready.
    if (gpuVerified || exitCode !== null) return;
    const placement = /(?:Node\(s\)|All nodes) placed on \[CUDAExecutionProvider\]\. Number of nodes: (\d+)/g;
    for (const match of output.matchAll(placement)) {
      if (Number(match[1]) < 100) continue;
      gpuVerified = true;
      if (readyReceived) {
        clearTimeout(verificationTimeout);
        events.emit('message', { kind: 'ready' });
      }
      break;
    }
  });
  child.stdout?.on('data', () => {});
  child.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'kind' in message && message.kind === 'load-error') {
      console.error('Local speech worker initialization failed', { model: runtime.model, backend: runtime.backend,
        error: 'message' in message ? message.message : 'Unknown initialization failure' });
    }
    if (message && typeof message === 'object' && 'kind' in message && message.kind === 'ready') {
      readyReceived = true;
      if (!gpuVerified) {
        verificationTimeout = setTimeout(() => events.emit('message', {
          kind: 'load-error', message: outOfMemory ? GPU_OUT_OF_MEMORY_LOG
            : 'The Parakeet encoder did not execute on CUDA. Choose CPU or repair GPU setup.',
        }), 1000);
        return;
      }
    }
    events.emit('message', message);
  });
  child.on('exit', code => {
    exitCode = code;
    clearTimeout(verificationTimeout);
    const exited = () => {
      if (code !== 0) console.error('Local speech worker exited', { model: runtime.model, backend: runtime.backend, code, diagnostic });
      // A crash that logged a CUDA allocation failure fails the load or decode as out of memory, not as a broken GPU.
      if (code !== 0 && outOfMemory) events.emit('message', { kind: 'load-error', message: GPU_OUT_OF_MEMORY_LOG });
      events.emit('exit', code);
    };
    // Electron can report exit before the last stderr chunk, so a GPU crash briefly waits for stderr to end.
    if (code === 0 || runtime.backend !== 'cuda' || !child.stderr) return exited();
    void Promise.race([once(child.stderr, 'end'), new Promise(resolve => setTimeout(resolve, 250))]).then(exited, exited);
  });
  return {
    postMessage: (message: unknown) => child.postMessage(message),
    kill: () => { clearTimeout(verificationTimeout); return child.kill(); },
    on: events.on.bind(events),
  };
}
