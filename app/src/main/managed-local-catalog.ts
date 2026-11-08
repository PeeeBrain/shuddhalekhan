import type { ManagedLocalTarget } from '../types/ipc';
import { MANAGED_LOCAL_MODEL, type ManagedLocalLegacyModel, type ManagedLocalModelManifest } from './managed-local-model';

// GPU files come straight from their upstream releases, pinned by version and SHA-256; we host nothing.
// A GPU setup is a list of these parts: [model files, native library, ...CUDA libraries], all put on the worker's
// library search path. Upstream publishes x64 CUDA builds for Windows and Linux only.
export const CUDA_SUPPORTED = process.arch === 'x64' && (process.platform === 'win32' || process.platform === 'linux');
const linux = process.platform === 'linux';

/** NVIDIA's official CUDA redistributables, as published to PyPI; only the wheel's native libraries are extracted. */
const nvidiaWheel = (family: string, version: string, path: string, downloadBytes: number, sha256: string,
  installedBytes: number, requiredFiles: string[]): ManagedLocalModelManifest => ({
  id: `nvidia-${family}`, version, name: `NVIDIA ${family}`, languages: [], downloadBytes, installedBytes,
  artifactUrl: `https://files.pythonhosted.org/packages/${path}`, sha256,
  ...linux
    ? { archiveRoot: `nvidia/${family}/lib`, include: [`nvidia/${family}/lib/*.so*`] }
    : { archiveRoot: `nvidia/${family}/bin`, include: [`nvidia/${family}/bin/*.dll`] },
  requiredFiles,
});
const CUDART = linux
  ? nvidiaWheel('cuda_runtime', '12.8.90', '0d/9b/a997b638fcd068ad6e4d53b8551a7d30fe8b404d6f1804abf1df69838932/nvidia_cuda_runtime_cu12-12.8.90-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
    954_765, 'adade8dcbd0edf427b7204d480d6066d33902cab2a4707dcfc48a2d0fd44ab90', 728_800, ['libcudart.so.12'])
  : nvidiaWheel('cuda_runtime', '12.8.90', '30/a5/a515b7600ad361ea14bfa13fb4d6687abf500adc270f19e89849c0590492/nvidia_cuda_runtime_cu12-12.8.90-py3-none-win_amd64.whl',
    944_318, 'c0c6027f01505bfed6c3b21ec546f69c687689aad5f1a377554bc6ca4aa993a8', 573_952, ['cudart64_12.dll']);
const CUBLAS = linux
  ? nvidiaWheel('cublas', '12.8.4.1', 'dc/61/e24b560ab2e2eaeb3c839129175fb330dfcfc29e5203196e5541a4c44682/nvidia_cublas_cu12-12.8.4.1-py3-none-manylinux_2_27_x86_64.whl',
    594_346_921, '8ac4e771d5a348c551b2a426eda6193c19aa630236b418086020df5ba9667142', 868_914_192, ['libcublas.so.12', 'libcublasLt.so.12'])
  : nvidiaWheel('cublas', '12.8.4.1', '70/61/7d7b3c70186fb651d0fbd35b01dbfc8e755f69fd58f817f3d0f642df20c3/nvidia_cublas_cu12-12.8.4.1-py3-none-win_amd64.whl',
    567_544_208, '47e9b82132fa8d2b4944e708049229601448aaad7e6f296f630f2d1a32de35af', 788_719_104, ['cublas64_12.dll', 'cublasLt64_12.dll']);
const NVRTC = linux
  ? nvidiaWheel('cuda_nvrtc', '12.8.93', '05/6b/32f747947df2da6994e999492ab306a903659555dddc0fbdeb9d71f75e52/nvidia_cuda_nvrtc_cu12-12.8.93-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl',
    88_040_029, 'a7756528852ef889772a84c6cd89d41dfa74667e24cca16bb31f8f061e3e9994', 222_102_104, ['libnvrtc.so.12', 'libnvrtc-builtins.so.12.8'])
  : nvidiaWheel('cuda_nvrtc', '12.8.93', '45/51/52a3d84baa2136cc8df15500ad731d74d3a1114d4c123e043cb608d4a32b/nvidia_cuda_nvrtc_cu12-12.8.93-py3-none-win_amd64.whl',
    73_586_838, '7a4b6b2904850fe78e0bd179c4b655c404d4bb799ef03ddc60804247099ae909', 179_878_912, ['nvrtc64_120_0.dll', 'nvrtc-builtins64_128.dll']);
const CUDNN = linux
  ? nvidiaWheel('cudnn', '9.10.2.21', 'ba/51/e123d997aa098c61d029f76663dedbfb9bc8dcf8c60cbd6adbe42f76d049/nvidia_cudnn_cu12-9.10.2.21-py3-none-manylinux_2_27_x86_64.whl',
    706_758_467, '949452be657fa16687d0930933f032835951ef0892b37d2d53824d1a84dc97a8', 1_053_232_960, ['libcudnn.so.9', 'libcudnn_ops.so.9'])
  : nvidiaWheel('cudnn', '9.10.2.21', '3d/90/0bd6e586701b3a890fd38aa71c387dab4883d619d6e5ad912ccbd05bfd67/nvidia_cudnn_cu12-9.10.2.21-py3-none-win_amd64.whl',
    692_992_268, 'c6288de7d63e6cf62988f0923f96dc339cea362decb1bf5b3141883392a7d65e', 1_007_210_288, ['cudnn64_9.dll', 'cudnn_ops64_9.dll']);
/** Linux's ONNX Runtime CUDA provider links cuRAND; the Windows build does not. */
const CURAND = nvidiaWheel('curand', '10.3.9.90', 'fb/aa/6584b56dc84ebe9cf93226a5cde4d99080c8e90ab40f0c27bda7a0f29aa1/nvidia_curand_cu12-10.3.9.90-py3-none-manylinux_2_27_x86_64.whl',
  63_619_976, 'b32331d4f4df5d6eefa0554c565b626c7216f87a06a4f56fab27c3b68a830ec9', 136_749_240, ['libcurand.so.10']);

/** sherpa-onnx's CUDA build of the same version as the app's sherpa-onnx-node; supplies the CUDA ONNX Runtime. */
const SHERPA_CUDA_ROOT = linux
  ? 'sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-linux-x64-gpu'
  : 'sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda';
const SHERPA_CUDA: ManagedLocalModelManifest = {
  id: 'sherpa-onnx-cuda', version: '2.0.1', name: 'sherpa-onnx CUDA runtime', languages: [],
  artifactUrl: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/${SHERPA_CUDA_ROOT}.tar.bz2`,
  archiveRoot: `${SHERPA_CUDA_ROOT}/lib`,
  ...linux ? {
    downloadBytes: 393_636_488, installedBytes: 655_113_001,
    sha256: '2aa541a65c1e7d921a053283419b70b30c1f6ae0a0f52f64b947ebe88c5f2a77',
    include: [`${SHERPA_CUDA_ROOT}/lib/*.so`],
    requiredFiles: ['libonnxruntime.so', 'libonnxruntime_providers_shared.so', 'libonnxruntime_providers_cuda.so', 'libsherpa-onnx-c-api.so'],
  } : {
    downloadBytes: 597_231_017, installedBytes: 518_450_400,
    sha256: 'cd983fa95431a8a08555b15005e1effd0b771f161d30f7f3bd52d518da48f6b6',
    include: [`${SHERPA_CUDA_ROOT}/lib/*.dll`],
    requiredFiles: ['onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'onnxruntime_providers_cuda.dll', 'sherpa-onnx-c-api.dll'],
  },
};

/** transcribe.cpp's CUDA build of the same version as the app's transcribe-cpp. */
const TRANSCRIBE_CUDA_ROOT = linux ? 'transcribe-native-linux-x86_64-cuda' : 'transcribe-native-windows-x86_64-cuda';
const TRANSCRIBE_CUDA: ManagedLocalModelManifest = {
  id: 'transcribe-cpp-cuda', version: '0.4.1', name: 'transcribe.cpp CUDA runtime', languages: [],
  archiveRoot: TRANSCRIBE_CUDA_ROOT,
  ...linux ? {
    artifactUrl: 'https://github.com/handy-computer/transcribe.cpp/releases/download/v0.4.1/transcribe-native-0.4.1-linux-x86_64-cuda.tar.gz',
    downloadBytes: 203_199_021, installedBytes: 256_330_765,
    sha256: 'c4bdf9c4798bac1868ecdcaa04f27eb7712fb43125268313ce14d508c70d247d',
    requiredFiles: ['libtranscribe.so', 'libggml-cuda.so'],
  } : {
    artifactUrl: 'https://github.com/handy-computer/transcribe.cpp/releases/download/v0.4.1/transcribe-native-0.4.1-windows-x86_64-cuda.tar.gz',
    downloadBytes: 202_587_464, installedBytes: 248_930_815,
    sha256: 'ba43fb21a3fe0ab2630e0614fbd742e039c389c68ad10fe23aca903f986adc5b',
    requiredFiles: ['transcribe.dll', 'ggml-cuda.dll'],
  },
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

export const LOCAL_FORMATTING_MODEL: ManagedLocalModelManifest = {
  id: 'english-punctuation-casing', version: '2024-08-06', name: 'English punctuation and capitalization',
  languages: ['English'], downloadBytes: 30_667_839, installedBytes: 7_639_930,
  artifactUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-online-punct-en-2024-08-06.tar.bz2',
  sha256: '9f5e5a72c7d2829635bd074fce92b6bbd5b78da8a52e7ad8ed1be933f366b99d',
  archiveRoot: 'sherpa-onnx-online-punct-en-2024-08-06',
  include: ['sherpa-onnx-online-punct-en-2024-08-06/model.int8.onnx', 'sherpa-onnx-online-punct-en-2024-08-06/bpe.vocab'],
  requiredFiles: ['model.int8.onnx', 'bpe.vocab'],
};

export const LOCAL_MODELS = [
  { key: 'parakeet', name: 'Parakeet', languages: ['English'],
    description: 'Best accuracy and formatting.',
    cpu: { ...MANAGED_LOCAL_MODEL, name: 'Parakeet unified English' },
    cuda: [PARAKEET_FP32, SHERPA_CUDA, CUDNN, CUBLAS, CUDART, NVRTC, ...linux ? [CURAND] : []],
  },
  { key: 'granite', name: 'Granite', languages: ['English'],
    description: 'Smaller and faster, with local punctuation and capitalization.',
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
