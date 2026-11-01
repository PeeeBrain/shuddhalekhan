import { join } from 'path';
import { createRequire } from 'module';
import type { OfflineRecognizer } from 'sherpa-onnx-node';
import { managedLocalRecognizerConfig } from './managed-local-model';
import type { LocalRuntime } from './managed-local-engine';

export async function createLocalRecognizer(runtime: LocalRuntime, numThreads: number): Promise<Pick<OfflineRecognizer, 'createStream' | 'decodeAsync'>> {
  if (runtime.model === 'parakeet') {
    // Import only after the worker's DLL search path has been set, never in Electron main.
    const require = createRequire(join(__dirname, 'local-stt.cjs'));
    const sherpa: typeof import('sherpa-onnx-node') = require(runtime.backend === 'cpu'
      ? 'sherpa-onnx-node' : join(requireRuntime(runtime), 'sherpa-onnx-node/non-streaming-asr.js'));
    return sherpa.OfflineRecognizer.createAsync(managedLocalRecognizerConfig(runtime.modelPath, numThreads, runtime.backend));
  }
  if (runtime.backend === 'cuda') {
    process.env.TRANSCRIBE_LIBRARY = join(requireRuntime(runtime), 'transcribe/transcribe.dll');
  } else {
    // Ignore inherited developer overrides; CPU preference must not load a CUDA provider.
    delete process.env.TRANSCRIBE_LIBRARY;
  }
  const native = await import('transcribe-cpp');
  if (runtime.backend === 'cpu') {
    // FFI uses the OS loader, which cannot read DLLs through Electron's virtual ASAR paths.
    const directory = native.artifactDir().replace(/\.asar([\\/])/, '.asar.unpacked$1');
    const library = process.platform === 'win32' ? 'transcribe.dll'
      : process.platform === 'darwin' ? 'libtranscribe.dylib' : 'libtranscribe.so';
    process.env.TRANSCRIBE_LIBRARY = join(directory, library);
  }
  native.setLogHandler(null);
  await native.initialize();
  const device = (await native.getAvailableBackendsAsync()).find(item =>
    item.kind === runtime.backend && (runtime.backend === 'cpu' || item.deviceType === 'gpu'));
  if (!device) throw new Error('No compatible dedicated NVIDIA CUDA device was found. Choose CPU or install a current NVIDIA driver.');
  const model = await native.TranscribeModel.load(join(runtime.modelPath, 'model.gguf'), { backend: runtime.backend, device });
  if (model.device.kind !== runtime.backend) throw new Error('The requested inference backend was not selected.');
  const session = model.createSession({ nThreads: numThreads });
  return {
    createStream() {
      let samples: Float32Array = new Float32Array();
      return { get samples() { return samples; }, acceptWaveform(wave: { samples: Float32Array; sampleRate: number }) {
        if (wave.sampleRate !== 16_000) throw new Error('Local speech recognition requires 16 kHz audio.');
        samples = wave.samples;
      } };
    },
    async decodeAsync(stream) {
      if (!('samples' in stream) || !(stream.samples instanceof Float32Array)) throw new Error('Invalid local audio stream.');
      const result = await session.run(stream.samples, { language: 'en', timestamps: 'none' });
      if (result.aborted || result.truncated) throw new Error('Local transcription was interrupted or truncated.');
      return { text: result.text, tokens: [], timestamps: [], durations: [], ys_log_probs: [] };
    },
  };
}

function requireRuntime(runtime: LocalRuntime): string {
  if (!runtime.runtimePath) throw new Error('Install GPU acceleration files in Settings.');
  return runtime.runtimePath;
}
