import { join } from 'path';
import { createRequire } from 'module';
import type { LocalRecognizer } from './managed-local-decode';
import { managedLocalRecognizerConfig } from './managed-local-model';
import type { LocalRuntime } from './managed-local-engine';
import { localVocabularySchema } from './managed-local-vocabulary';
import { writeFileSync } from 'fs';
import { formatLocalText } from './managed-local-formatting';

export async function createLocalRecognizer(runtime: LocalRuntime, numThreads: number): Promise<LocalRecognizer> {
  const format = () => {
    if (!runtime.formattingPath) return undefined;
    const require = createRequire(join(__dirname, 'local-stt.cjs'));
    const sherpa: typeof import('sherpa-onnx-node') = require('sherpa-onnx-node');
    const options = join(runtime.formattingPath, 'ort-session.cfg');
    writeFileSync(options, 'EnableCpuMemArena=0\nSessionConfig.session.intra_op.allow_spinning=0\nSessionConfig.session.inter_op.allow_spinning=0');
    const punctuation = new sherpa.OnlinePunctuation({ model: {
      cnnBilstm: join(runtime.formattingPath, 'model.int8.onnx'), bpeVocab: join(runtime.formattingPath, 'bpe.vocab'),
      numThreads: 1, provider: `cpu:${options}`,
    } });
    return (text: string, dictionary: readonly string[]) => formatLocalText(text, value => punctuation.addPunct(value), dictionary);
  };
  if (runtime.model === 'parakeet') {
    // Import only after the worker's DLL search path has been set, never in Electron main.
    const require = createRequire(join(__dirname, 'local-stt.cjs'));
    if (runtime.backend === 'cuda') {
      // Windows binds a DLL import to an already loaded module of the same name, so loading sherpa-onnx's
      // CUDA build first makes the app's own addon use it instead of the CPU build bundled beside it.
      const koffi: typeof import('koffi') = require('koffi');
      const directory = libraryDirectory(runtime);
      koffi.load(join(directory, 'onnxruntime.dll'));
      koffi.load(join(directory, 'sherpa-onnx-c-api.dll'));
    }
    const sherpa: typeof import('sherpa-onnx-node') = require('sherpa-onnx-node');
    const recognizer = await sherpa.OfflineRecognizer.createAsync(
      managedLocalRecognizerConfig(runtime.modelPath, numThreads, runtime.backend, runtime.contextual));
    return {
      format: format(),
      createStream(dictionary) {
        if (dictionary?.length && !runtime.contextual) throw new Error('Restart local speech recognition to enable vocabulary.');
        return recognizer.createStream(dictionary?.length ? localVocabularySchema.parse(dictionary).join('/') : undefined);
      },
      decodeAsync: stream => recognizer.decodeAsync(stream),
    };
  }
  if (runtime.backend === 'cuda') {
    process.env.TRANSCRIBE_LIBRARY = join(libraryDirectory(runtime), 'transcribe.dll');
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
    format: format(),
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

function libraryDirectory(runtime: LocalRuntime): string {
  const [directory] = runtime.libraryPaths ?? [];
  if (!directory) throw new Error('Install GPU acceleration files in Settings.');
  return directory;
}
