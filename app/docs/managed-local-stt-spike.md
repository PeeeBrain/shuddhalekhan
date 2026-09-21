# Managed Local STT spike

## Decision

Use Electron `utilityProcess` with `sherpa-onnx-node` and the pinned sherpa-onnx Parakeet TDT 0.6B v3 INT8 model.

The production bundle builds `out/main/local-stt.cjs`; the Windows package includes the x64 sherpa addon and ONNX Runtime DLLs under `app.asar.unpacked`. Main and the utility process communicate with Electron structured messages. Inference never runs on Electron main.

## Candidate comparison

| Candidate | Packaging | CPU fallback | Isolation | Decision |
| --- | --- | --- | --- | --- |
| Electron utility process + sherpa-onnx | Prebuilt Windows x64 N-API package; verified in the unpacked Electron build | Yes | Separate process with restart on next request | Chosen: smallest path through the existing TypeScript/Electron stack |
| RuntimeShell Web Worker + parakeet.js | No native addon, but WebGPU encoder uses FP32 and threaded WASM needs cross-origin isolation | WASM fallback | Renderer worker; renderer loss couples capture and inference | Rejected for the first version |
| Rust `transcribe-rs` sidecar | Separate executable and Rust build/release pipeline | Yes, including DirectML options | Separate process | Kept as fallback if the Node addon fails product measurements |

## Pinned model

- Artifact: `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`
- Download: 487,170,055 bytes
- SHA-256: `5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf`
- Installed size shown to users: about 640 MB
- Coverage: the 25 European languages published for this model

The installer does not contain the model. Model installation resumes a partial HTTP download, verifies the complete archive, validates archive paths and entry types, extracts into staging, validates required files, and atomically promotes the directory.

## Verification

- Focused tests cover config preservation, download/resume/hash/path safety/staging/delete, WAV validation, runtime load/crash/restart, provider routing, and onboarding completion.
- `electron-vite build` emits the utility entry.
- `electron-builder --dir` includes `sherpa-onnx-win-x64`, `sherpa-onnx.node`, and ONNX Runtime DLLs outside the ASAR archive.
- Final cold-load, 5 s/15 s latency, RAM, idle cost, and transcript-quality baselines require the real packaged-app corpus pass described in the issue; record them with the existing Windows performance harness before release.

References: [sherpa-onnx JavaScript install](https://k2-fsa.github.io/sherpa/onnx/javascript-api/install.html), [sherpa-onnx Parakeet models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html), [parakeet.js](https://github.com/ysdede/parakeet.js), and [transcribe-rs](https://github.com/altunenes/transcribe-rs).
