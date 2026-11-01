import type { ManagedLocalTarget } from '../types/ipc';
import { MANAGED_LOCAL_MODEL, type ManagedLocalLegacyModel, type ManagedLocalModelManifest } from './managed-local-model';

const RELEASE = 'https://github.com/PeeeBrain/shuddhalekhan/releases/download/local-models-v1';

export const LOCAL_MODELS = [
  { key: 'parakeet', name: 'Parakeet', languages: ['English'],
    description: 'Best accuracy and formatting. Unified English 600M, with compact INT8 CPU files.',
    cpu: { ...MANAGED_LOCAL_MODEL, name: 'Parakeet unified English' },
    cuda: {
      id: 'parakeet-unified-en-cuda-w4g32', version: '1', name: 'Parakeet GPU acceleration',
      languages: ['English'], downloadBytes: 2_020_235_613, installedBytes: 2_988_411_410,
      artifactUrl: `${RELEASE}/parakeet-unified-en-cuda-w4g32-1.tar.bz2`,
      sha256: 'f3f9a1dc521d7263db34bbab29edfdbe82b55019126ed168006c466a4081b488',
      archiveRoot: 'parakeet-unified-en-cuda-w4g32-1',
      requiredFiles: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt',
        'runtime/sherpa-onnx-node/non-streaming-asr.js', 'runtime/sherpa-onnx-win-x64/sherpa-onnx.node',
        'runtime/sherpa-onnx-win-x64/onnxruntime_providers_cuda.dll', 'runtime/bin/cudnn64_9.dll'],
    },
  },
  { key: 'granite', name: 'Granite', languages: ['English'],
    description: 'Compact and fast. Speech 5 TurboCTC 470M Q4 uses less memory, with weaker punctuation and capitalization.',
    cpu: {
      id: 'granite-470m-q4', version: '1', name: 'Granite Speech 5 TurboCTC Q4',
      languages: ['English'], downloadBytes: 279_114_080, installedBytes: 279_114_080,
      artifactUrl: 'https://huggingface.co/handy-computer/granite-speech-5.0-470m-turboctc-GGUF/resolve/0cf5be9f4bcd479989e6a24d142094d34d552daa/granite-speech-5.0-470m-turboctc-Q4_K_M.gguf',
      sha256: '3f30525381d72246b7f99e49b6cb66b249cf1b990c6c3d0e031a7765735f513e',
      archiveRoot: 'model', requiredFiles: ['model.gguf'], format: 'file',
    },
    cuda: {
      id: 'granite-470m-q4-cuda', version: '1', name: 'Granite GPU acceleration',
      languages: ['English'], downloadBytes: 1_018_511_434, installedBytes: 1_317_371_240,
      artifactUrl: `${RELEASE}/granite-470m-q4-cuda-1.tar.bz2`,
      sha256: '9ff45a2ffbc1774c194f384325f1347bf2bdf1fc764db477c655bb0e3e3aed26',
      archiveRoot: 'granite-470m-q4-cuda-1', requiredFiles: ['model.gguf', 'runtime/transcribe/transcribe.dll',
        'runtime/transcribe/ggml-cuda.dll', 'runtime/bin/cudart64_12.dll', 'runtime/bin/cublas64_12.dll', 'runtime/bin/cublasLt64_12.dll'],
    },
  },
] satisfies Array<{ key: ManagedLocalTarget['model']; name: string; languages: string[]; description: string;
  cpu: ManagedLocalModelManifest; cuda: ManagedLocalModelManifest }>;

/** Parakeet CPU files shipped before the unified English model; same file names, runtime, and transducer config. */
const LEGACY_PARAKEET_CPU: ManagedLocalLegacyModel = {
  id: 'parakeet-tdt-0.6b-v3-int8', version: '1', name: 'Parakeet TDT v3 multilingual (previous version)',
  downloadBytes: 487_170_055, installedBytes: 640_000_000,
  languages: [
    'English', 'French', 'German', 'Spanish', 'Italian', 'Portuguese', 'Dutch',
    'Polish', 'Czech', 'Slovak', 'Romanian', 'Hungarian', 'Bulgarian', 'Croatian',
    'Slovenian', 'Lithuanian', 'Latvian', 'Estonian', 'Finnish', 'Maltese',
    'Swedish', 'Danish', 'Greek', 'Russian', 'Ukrainian',
  ],
  requiredFiles: MANAGED_LOCAL_MODEL.requiredFiles,
};

export function legacyLocalModel(target: ManagedLocalTarget): ManagedLocalLegacyModel | undefined {
  return target.model === 'parakeet' && target.backend === 'cpu' ? LEGACY_PARAKEET_CPU : undefined;
}

export function localModelManifest(target: ManagedLocalTarget): ManagedLocalModelManifest {
  const model = LOCAL_MODELS.find(item => item.key === target.model);
  if (!model) throw new Error('Unknown local speech model.');
  return model[target.backend];
}
