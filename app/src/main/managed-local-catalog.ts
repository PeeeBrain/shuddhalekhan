import type { ManagedLocalTarget } from '../types/ipc';
import { MANAGED_LOCAL_MODEL, type ManagedLocalLegacyModel, type ManagedLocalModelManifest } from './managed-local-model';

// GPU files come straight from their upstream releases, pinned by version and SHA-256; we host nothing.
// A GPU setup is a list of these parts: [model files, native library, ...CUDA libraries], all put on the worker's PATH.

/** NVIDIA's official CUDA redistributables, as published to PyPI; only `nvidia/<family>/bin/*.dll` is extracted. */
const nvidiaWheel = (family: string, version: string, path: string, downloadBytes: number, sha256: string,
  installedBytes: number, requiredFiles: string[]): ManagedLocalModelManifest => ({
  id: `nvidia-${family}`, version, name: `NVIDIA ${family}`, languages: [], downloadBytes, installedBytes,
  artifactUrl: `https://files.pythonhosted.org/packages/${path}`, sha256,
  archiveRoot: `nvidia/${family}/bin`, include: [`nvidia/${family}/bin/*.dll`], requiredFiles,
});
const CUDART = nvidiaWheel('cuda_runtime', '12.8.90', '30/a5/a515b7600ad361ea14bfa13fb4d6687abf500adc270f19e89849c0590492/nvidia_cuda_runtime_cu12-12.8.90-py3-none-win_amd64.whl',
  944_318, 'c0c6027f01505bfed6c3b21ec546f69c687689aad5f1a377554bc6ca4aa993a8', 573_952, ['cudart64_12.dll']);
const CUBLAS = nvidiaWheel('cublas', '12.8.4.1', '70/61/7d7b3c70186fb651d0fbd35b01dbfc8e755f69fd58f817f3d0f642df20c3/nvidia_cublas_cu12-12.8.4.1-py3-none-win_amd64.whl',
  567_544_208, '47e9b82132fa8d2b4944e708049229601448aaad7e6f296f630f2d1a32de35af', 788_719_104, ['cublas64_12.dll', 'cublasLt64_12.dll']);
const NVRTC = nvidiaWheel('cuda_nvrtc', '12.8.93', '45/51/52a3d84baa2136cc8df15500ad731d74d3a1114d4c123e043cb608d4a32b/nvidia_cuda_nvrtc_cu12-12.8.93-py3-none-win_amd64.whl',
  73_586_838, '7a4b6b2904850fe78e0bd179c4b655c404d4bb799ef03ddc60804247099ae909', 179_878_912, ['nvrtc64_120_0.dll', 'nvrtc-builtins64_128.dll']);
const CUDNN = nvidiaWheel('cudnn', '9.10.2.21', '3d/90/0bd6e586701b3a890fd38aa71c387dab4883d619d6e5ad912ccbd05bfd67/nvidia_cudnn_cu12-9.10.2.21-py3-none-win_amd64.whl',
  692_992_268, 'c6288de7d63e6cf62988f0923f96dc339cea362decb1bf5b3141883392a7d65e', 1_007_210_288, ['cudnn64_9.dll', 'cudnn_ops64_9.dll']);

/** sherpa-onnx's CUDA build of the same version as the app's sherpa-onnx-node; supplies the CUDA ONNX Runtime. */
const SHERPA_CUDA_ROOT = 'sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda';
const SHERPA_CUDA: ManagedLocalModelManifest = {
  id: 'sherpa-onnx-cuda', version: '2.0.1', name: 'sherpa-onnx CUDA runtime', languages: [],
  downloadBytes: 597_231_017, installedBytes: 518_450_400,
  artifactUrl: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/${SHERPA_CUDA_ROOT}.tar.bz2`,
  sha256: 'cd983fa95431a8a08555b15005e1effd0b771f161d30f7f3bd52d518da48f6b6',
  archiveRoot: `${SHERPA_CUDA_ROOT}/lib`, include: [`${SHERPA_CUDA_ROOT}/lib/*.dll`],
  requiredFiles: ['onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'onnxruntime_providers_cuda.dll', 'sherpa-onnx-c-api.dll'],
};

/** transcribe.cpp's CUDA build of the same version as the app's transcribe-cpp. */
const TRANSCRIBE_CUDA: ManagedLocalModelManifest = {
  id: 'transcribe-cpp-cuda', version: '0.4.1', name: 'transcribe.cpp CUDA runtime', languages: [],
  downloadBytes: 202_587_464, installedBytes: 248_930_815,
  artifactUrl: 'https://github.com/handy-computer/transcribe.cpp/releases/download/v0.4.1/transcribe-native-0.4.1-windows-x86_64-cuda.tar.gz',
  sha256: 'ba43fb21a3fe0ab2630e0614fbd742e039c389c68ad10fe23aca903f986adc5b',
  archiveRoot: 'transcribe-native-windows-x86_64-cuda', requiredFiles: ['transcribe.dll', 'ggml-cuda.dll'],
};

/** Full-precision Parakeet published by the sherpa-onnx author; the int8 CPU model runs poorly on CUDA. */
const PARAKEET_FP32_REPO = 'https://huggingface.co/csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-non-streaming/resolve/e69c9fb5322532e9995b116b6f1e4b34ab0c4b13';
const PARAKEET_FP32_FILES = [
  { name: 'encoder.onnx', bytes: 41_900_099, sha256: 'b96ad329f7190b672655c7c5020e191098705d4a736508012b89ad8ef820315a' },
  { name: 'encoder.weights', bytes: 2_437_091_328, sha256: 'c054b2932ee13aa39ed84982a399822f3193311fb6fd8e1e204566722614bd87' },
  { name: 'decoder.onnx', bytes: 28_883_664, sha256: '41136a36f1673de81e1b5182f2aad09791815ec6cc9861ebaf2c56b1a374474f' },
  { name: 'joiner.onnx', bytes: 6_894_757, sha256: '680ddf13ab1f8a75b8d9f831980124b826dbbf4640f92cdfd30b72d4d2e811a4' },
  { name: 'tokens.txt', bytes: 8_952, sha256: 'dc0b4584ab2e4ddbf888425c076c61b736e7356a015250db7d307e6f1a8188ff' },
].map(file => ({ ...file, url: `${PARAKEET_FP32_REPO}/${file.name}` }));
const PARAKEET_FP32: ManagedLocalModelManifest = {
  id: 'parakeet-unified-en-0.6b-fp32', version: 'e69c9fb', name: 'Parakeet unified English (full precision)',
  languages: ['English'], downloadBytes: 2_514_778_800, installedBytes: 2_514_778_800,
  files: PARAKEET_FP32_FILES, requiredFiles: PARAKEET_FP32_FILES.map(file => file.name),
};

const GRANITE_Q4: ManagedLocalModelManifest = {
  id: 'granite-470m-q4', version: '1', name: 'Granite Speech 5 TurboCTC Q4',
  languages: ['English'], downloadBytes: 279_114_080, installedBytes: 279_114_080,
  files: [{ name: 'model.gguf', bytes: 279_114_080, sha256: '3f30525381d72246b7f99e49b6cb66b249cf1b990c6c3d0e031a7765735f513e',
    url: 'https://huggingface.co/handy-computer/granite-speech-5.0-470m-turboctc-GGUF/resolve/0cf5be9f4bcd479989e6a24d142094d34d552daa/granite-speech-5.0-470m-turboctc-Q4_K_M.gguf' }],
  requiredFiles: ['model.gguf'],
};

export const LOCAL_MODELS = [
  { key: 'parakeet', name: 'Parakeet', languages: ['English'],
    description: 'Best accuracy and formatting.',
    cpu: { ...MANAGED_LOCAL_MODEL, name: 'Parakeet unified English' },
    cuda: [PARAKEET_FP32, SHERPA_CUDA, CUDNN, CUBLAS, CUDART, NVRTC],
  },
  { key: 'granite', name: 'Granite', languages: ['English'],
    description: 'Smaller and faster, with weaker punctuation.',
    cpu: GRANITE_Q4,
    cuda: [GRANITE_Q4, TRANSCRIBE_CUDA, CUBLAS, CUDART],
  },
] satisfies Array<{ key: ManagedLocalTarget['model']; name: string; languages: string[]; description: string;
  cpu: ManagedLocalModelManifest; cuda: ManagedLocalModelManifest[] }>;

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

export function legacyLocalModel(model: ManagedLocalTarget['model']): ManagedLocalLegacyModel | undefined {
  return model === 'parakeet' ? LEGACY_PARAKEET_CPU : undefined;
}
