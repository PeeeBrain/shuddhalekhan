# Local model inference

Managed Local supports Parakeet unified English 600M and Granite Speech 5 TurboCTC 470M. Parakeet uses the existing Sherpa-ONNX 2.0.1 API with lean ONNX Runtime sessions. Granite uses transcribe.cpp 0.4.1 through its Node binding, in the same Electron utility-process boundary. Neither inference path invokes Python or Docker.

`managedLocal` stores the selected model and a separate `auto`, `cpu`, or `cuda` preference for each model. Missing settings default to Parakeet/Auto. CPU threads remain a separate setting. Only model/device IDs cross IPC; paths and artifact URLs come from the pinned catalog in main.

Auto requires CPU files. It tries an installed CUDA bundle, verifies startup, and otherwise uses CPU. A failed GPU is not retried every recording until settings or installed assets change. A GPU worker failure during incremental decoding falls back through the existing completed-WAV path. A failure during batch transcription retries that WAV on CPU. Dedicated GPU never substitutes CPU. Other GPU vendors currently use CPU. No model or GPU runtime downloads happen automatically.

The engine reserves a recording before worker startup, so deleting model files is rejected during startup and active inference. A completed-WAV retry keeps the recording's original model and device preference, including whether CPU fallback is allowed. Each replacement worker is a new process so incompatible ONNX/ggml/CUDA DLL sets cannot mix. Parakeet GPU readiness requires encoder node-placement evidence on CUDA, plus a successful warm-up decode. Granite checks the selected native device and also warms up. Hardware names are informational, not proof of acceleration.

## Models and artifacts

- Parakeet CPU: upstream unified English INT8 archive, preserving the existing install ID.
- Parakeet CUDA: the same checkpoint in full precision, published by the sherpa-onnx author on Hugging Face (about 2.5 GB, and roughly that much VRAM).
- Granite CPU: pinned English Q4_K_M GGUF. Its CPU native library ships through the npm dependency.
- Granite CUDA: the same Q4_K_M GGUF plus transcribe.cpp's CUDA build.

## GPU files come from upstream

We host no model or runtime files. A GPU setup is a list of parts, each one pinned upstream artifact with a version and SHA-256 in `src/main/managed-local-catalog.ts`:

- Parakeet: FP32 model files, the sherpa-onnx v2.0.1 CUDA release (its `lib/*.dll` only), and NVIDIA's cuDNN, cuBLAS, CUDA runtime, and NVRTC wheels from PyPI (their `bin/*.dll` only).
- Granite: the CPU GGUF, the transcribe.cpp v0.4.1 CUDA release, and NVIDIA's cuBLAS and CUDA runtime wheels.

Parts are installed in place by ID, so cuBLAS and the CUDA runtime download once for both models, and Granite GPU reuses the CPU GGUF. Deleting GPU files keeps CPU model files and anything another installed GPU setup still uses. Every part after the model goes on the worker's PATH. For Parakeet, the worker loads sherpa-onnx's CUDA `onnxruntime.dll` and `sherpa-onnx-c-api.dll` before requiring the app's own `sherpa-onnx-node`. Windows binds the addon's imports to those already-loaded modules, and the CUDA node-placement check fails loudly if that ever stops being true.

Bumping `sherpa-onnx-node` or `transcribe-cpp` means bumping the matching CUDA release in the catalog, which needs a new version, size and SHA-256. Nothing is uploaded on our side.

Existing multilingual Parakeet v3 CPU installs remain usable during an update, including after a failed download or extraction. Their original name and languages remain visible until the unified English replacement is ready. Previous files are retained until explicitly deleted in Settings.

Local setup includes the English Edge-Punct-Casing INT8 model through Sherpa's punctuation API. Its archive is pinned by SHA-256 and only the 7.5 MB model and BPE vocabulary are installed. Both acoustic backends run this small final-text step on one CPU thread, without spinning ONNX Runtime threads. Existing sentence punctuation is preserved, word-changing output is discarded, and recognized dictionary spellings retain their casing. Non-ASCII transcripts bypass the English formatter. The model is shared across installs and downloads only through an explicit setup action; older speech installations continue working before that action.

Parakeet remains recommended. A nonempty personal dictionary enables modified beam decoding with per-stream hotwords. The worker derives a SentencePiece BPE vocabulary from NeMo's verified token ranks, pins terms at recording start, and supplies them again for quiet-audio and CPU retries. Empty dictionaries retain greedy decoding. Terms are limited to 64 entries of at most 128 characters, with control characters, slashes, and colons rejected because the native hotword protocol reserves those characters. An incompatible previously saved list remains intact, with a Settings warning; local recording continues without vocabulary hints until the list is repaired. Granite TurboCTC's pinned native implementation does not support vocabulary hints; its editor remains hidden rather than accepting ignored hints.

CPU and CUDA variants have separate install/delete state. Download hashes, byte limits, archive path/link checks, staging, and atomic replacement apply to both. Progress notifications are rate limited; full state remains queryable.

Formatting checks on 2026-11-01 exercised the real Granite CPU and CUDA backends against the same public Sherpa sample. Both returned unformatted English, and the shared formatter restored sentence case and punctuation. A direct punctuation check produced `How are you? I am fine. Thank you.` in approximately 6 ms. Parakeet CPU hotword decoding ran against the same sample; its already punctuated output was preserved. These are narrow native smoke checks, not a corpus accuracy/latency qualification or an Electron UI pass. Updated Parakeet CUDA hotwords have not been verified on hardware. Granite vocabulary still requires native contextual-decoder support outside the current prebuilt dependency.

## Native verification

`scripts/verify-local-models.ts` is an explicitly invoked Electron integration check, excluded from default Bun tests. Bundle it and `src/main/local-stt.ts` to `out/main/*.cjs`, externalizing Electron, Sherpa, and transcribe.cpp. When bundling with Bun, define `__dirname` as the absolute `out/main` directory because Bun otherwise substitutes each source module's directory. The product's electron-vite bundle uses its output directory normally.

Run the bundled verifier with Electron and these arguments:

```
--root <install-directory>
--audio <16-kHz-PCM16-WAV>
--out <result-json-path>
```

The verifier downloads every pinned upstream part into `--root` through the real integrity-checking installer and reuses parts already there. Use a fresh directory to re-verify downloads. It checks both complete-WAV and incremental transcription through real Electron utility workers for every model/backend. It uses no personal app configuration and sends no keystrokes or clipboard input. CUDA verification requires compatible NVIDIA hardware and drivers. UI component tests cover explicit GPU setup and independent progress; lifecycle tests cover startup fallback, worker crashes, model switching, and persistence validation.

Verified on Windows with the RTX 4060 Laptop on 2026-11-01: 219 focused tests passed, app/tooling type checks and targeted lint passed, and both models completed batch and incremental decoding on CPU and CUDA. Native checks covered a short utterance and a longer recording. The longer check also passed through electron-vite output and an ASAR archive with unpacked native dependencies. The ASAR check found and verified the physical FFI library path requirement and Koffi platform-module packaging. Settings was inspected in Electron using isolated app data; before/after images are on PR #233. These are integration checks, not new accuracy or latency benchmarks. A full installer build and another VB-Cable/paste run were not performed for this feature.
