# Local model inference

Managed Local supports Parakeet unified English 600M and Granite Speech 5 TurboCTC 470M. Parakeet uses the existing Sherpa-ONNX 2.0.1 API with lean ONNX Runtime sessions. Granite uses transcribe.cpp 0.4.1 through its Node binding, in the same Electron utility-process boundary. Neither inference path invokes Python or Docker.

`managedLocal` stores the selected model and a separate `auto`, `cpu`, or `cuda` preference for each model. Missing settings default to Parakeet/Auto. CPU threads remain a separate setting. Only model/device IDs cross IPC; paths and artifact URLs come from the pinned catalog in main.

Auto requires CPU files. It tries an installed CUDA bundle, verifies startup, and otherwise uses CPU. A failed GPU is not retried every recording until settings or installed assets change. A GPU worker failure during incremental decoding falls back through the existing completed-WAV path. A failure during batch transcription retries that WAV on CPU. Dedicated GPU never substitutes CPU. Other GPU vendors currently use CPU. No model or GPU runtime downloads happen automatically.

The engine reserves a recording before worker startup, so deleting model files is rejected during startup and active inference. A completed-WAV retry keeps the recording's original model and device preference, including whether CPU fallback is allowed. Each replacement worker is a new process so incompatible ONNX/ggml/CUDA DLL sets cannot mix. Parakeet GPU readiness requires encoder node-placement evidence on CUDA, plus a successful warm-up decode. Granite checks the selected native device and also warms up. Hardware names are informational, not proof of acceleration.

## Models and artifacts

- Parakeet CPU: upstream unified English INT8 archive, preserving the existing install ID.
- Parakeet CUDA: the tested unified English W4/g32 export with FP16 activations and FP32 public interfaces. This is the same checkpoint as CPU, not multilingual v3. It includes matching Sherpa CUDA/ORT libraries and CUDA dependencies.
- Granite CPU: pinned English Q4_K_M GGUF. Its CPU native library ships through the npm dependency.
- Granite CUDA: the same Q4_K_M GGUF, matching CUDA native library, and CUDA dependencies.

Existing multilingual Parakeet v3 CPU installs remain usable during an update, including after a failed download or extraction. Their original name and languages remain visible until the unified English replacement is ready. Previous files are retained until explicitly deleted in Settings.

The UI describes Granite's weaker punctuation and capitalization. Parakeet remains recommended. CPU and CUDA variants have separate install/delete state. Download hashes, byte limits, archive path/link checks, staging, and atomic replacement apply to both. Progress notifications are rate limited; full state remains queryable.

## Release bundles

GPU bundles are generated outside Git under `app/eval-data/local-gpu-release-normalized/`. They are not published by this change. The catalog reserves these URLs under the separate GitHub asset tag `local-models-v1`:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `parakeet-unified-en-cuda-w4g32-1.tar.bz2` | 2,020,235,613 | `f3f9a1dc521d7263db34bbab29edfdbe82b55019126ed168006c466a4081b488` |
| `granite-470m-q4-cuda-1.tar.bz2` | 1,018,511,434 | `9ff45a2ffbc1774c194f384325f1347bf2bdf1fc764db477c655bb0e3e3aed26` |

Upload the exact generated files before releasing this feature. Keep this model-asset release separate from the application's latest update release. A new bundle must receive a new version/URL and matching catalog checksum. The public GPU setup buttons cannot download successfully until these assets are hosted. CPU downloads use existing upstream URLs.

`scripts/package-local-gpu.ps1 -ArtifactRoot <prepared-artifact-directory> -OutputDirectory <fresh-output-directory>` packages the already-tested converted weights and native files. The input layout is recorded in the script; model conversion and acquisition happen before packaging. It verifies model checksums and includes conversion metadata and upstream license notices. It deliberately refuses to overwrite a staging directory. It does not convert models or upload anything. Conversion/benchmark code and datasets stay in the original research worktree; they are not part of this feature.

## Native verification

`scripts/verify-local-models.ts` is an explicitly invoked Electron integration check, excluded from default Bun tests. Bundle it and `src/main/local-stt.ts` to `out/main/*.cjs`, externalizing Electron, Sherpa, and transcribe.cpp. When bundling with Bun, define `__dirname` as the absolute `out/main` directory because Bun otherwise substitutes each source module's directory. The product's electron-vite bundle uses its output directory normally.

Run the bundled verifier with Electron and these arguments:

```
--root <new-nonexistent-install-directory>
--bundles <directory-containing-the-two-release-archives>
--parakeet-cpu <existing-unified-English-INT8-install>
--granite-gguf <pinned-Granite-Q4-file>
--audio <16-kHz-PCM16-WAV>
--out <result-json-path>
```

The verifier requires a fresh install directory and rejects existing directories, so a cached installation cannot bypass verification of the supplied bundles. It seeds resumable download files from local artifacts, then runs the actual integrity-checking installer and extraction. It checks both complete-WAV and incremental transcription through real Electron utility workers for every model/backend. It uses no personal app configuration and sends no keystrokes or clipboard input. CUDA verification requires compatible NVIDIA hardware and drivers. UI component tests cover explicit GPU setup and independent progress; lifecycle tests cover startup fallback, worker crashes, model switching, and persistence validation.

Verified on Windows with the RTX 4060 Laptop on 2026-11-01: 219 focused tests passed, app/tooling type checks and targeted lint passed, and both models completed batch and incremental decoding on CPU and CUDA. Native checks covered a short utterance and a longer recording. The longer check also passed through electron-vite output and an ASAR archive with unpacked native dependencies. The ASAR check found and verified the physical FFI library path requirement and Koffi platform-module packaging. Settings was inspected in Electron using isolated app data, with before/after images in `docs/images/local-inference-*.png`. These are integration checks, not new accuracy or latency benchmarks. A full installer build and another VB-Cable/paste run were not performed for this feature.
