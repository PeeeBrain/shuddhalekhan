# Local speech model bundle notices

Parakeet unified English derives from NVIDIA's `nvidia/parakeet-unified-en-0.6b`, under the NVIDIA Open Model License. The Sherpa-compatible source export is pinned to `csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-non-streaming` revision `e69c9fb5322532e9995b116b6f1e4b34ab0c4b13`. We changed the export to W4/g32 constant MatMul weights and FP16 activations, retaining FP32 public interfaces. This is a modified export, not a new checkpoint. The bundle includes its conversion record.

Granite Speech 5.0 TurboCTC 470M derives from IBM Granite, under Apache 2.0. The GGUF Q4_K_M conversion is from `handy-computer/granite-speech-5.0-470m-turboctc-GGUF` revision `0cf5be9f4bcd479989e6a24d142094d34d552daa`.

Runtime components retain their respective licenses: Sherpa-ONNX 2.0.1, ONNX Runtime 1.28.2, transcribe.cpp 0.4.1 and its ggml backend, and NVIDIA CUDA 12 redistributables. The NVIDIA CUDA wheel license documents are copied into `licenses/`. The packaging script also includes the upstream model/runtime license documents. NVIDIA drivers are supplied by the user and are not redistributed.

Sources:

- https://huggingface.co/nvidia/parakeet-unified-en-0.6b
- https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/
- https://huggingface.co/handy-computer/granite-speech-5.0-470m-turboctc-GGUF/tree/0cf5be9f4bcd479989e6a24d142094d34d552daa
- https://github.com/k2-fsa/sherpa-onnx/tree/v2.0.1
- https://github.com/microsoft/onnxruntime/tree/v1.28.2
- https://github.com/handy-computer/transcribe.cpp/tree/v0.4.1
