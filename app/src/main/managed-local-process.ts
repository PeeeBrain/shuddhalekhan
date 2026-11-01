import { EventEmitter } from 'events';
import { join, delimiter } from 'path';
import type { LocalRuntime } from './managed-local-engine';

export async function startLocalRuntimeProcess(runtime: LocalRuntime) {
  const { utilityProcess } = await import('electron');
  const env = { ...process.env };
  if (runtime.libraryPaths) {
    for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH') delete env[name];
    env.PATH = [...runtime.libraryPaths, process.env.PATH ?? ''].join(delimiter);
  }
  const child = utilityProcess.fork(join(__dirname, 'local-stt.cjs'), [], {
    serviceName: 'Shuddhalekhan local speech recognition', env, stdio: 'pipe',
  });
  const events = new EventEmitter();
  let gpuVerified = runtime.backend !== 'cuda' || runtime.model !== 'parakeet';
  let readyReceived = false;
  let verificationTimeout: ReturnType<typeof setTimeout> | undefined;
  let diagnostic = '';
  // ORT may silently substitute CPU. Require encoder node placement on CUDA, not just a provider request.
  child.stderr?.on('data', (chunk: Buffer) => {
    const output = diagnostic + chunk.toString();
    diagnostic = output.slice(-1024);
    if (gpuVerified) return;
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
          kind: 'load-error', message: 'The Parakeet encoder did not execute on CUDA. Choose CPU or repair GPU setup.',
        }), 1000);
        return;
      }
    }
    events.emit('message', message);
  });
  child.on('exit', code => {
    clearTimeout(verificationTimeout);
    if (code !== 0) console.error('Local speech worker exited', { model: runtime.model, backend: runtime.backend, code, diagnostic });
    events.emit('exit', code);
  });
  return {
    postMessage: (message: unknown) => child.postMessage(message),
    kill: () => { clearTimeout(verificationTimeout); return child.kill(); },
    on: events.on.bind(events),
  };
}
