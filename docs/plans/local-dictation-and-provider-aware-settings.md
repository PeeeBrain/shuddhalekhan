# Local dictation and provider-aware transcription settings

Status: implementation in progress on 2026-11-01. Provider-aware Settings, atomic transitions, local punctuation/casing, and Parakeet vocabulary are implemented. Granite vocabulary remains blocked on native contextual-decoder support in the prebuilt TurboCTC runtime. The original investigation and intended completion criteria are retained below.

Implementation notes: the current converted Granite artifact is still the old checkpoint. Instead of an unverified checkpoint conversion, both local setups now explicitly install a small English punctuation-and-casing model through the existing integrity-checked installer. Native smoke checks exercised Granite CPU/CUDA formatting and Parakeet CPU hotwords; full accuracy qualification, Parakeet CUDA hotwords, and an Electron UI pass remain unverified. No native fork or replacement runtime has been shipped for Granite vocabulary.

Validation: 342 focused tests across 21 relevant files passed. App typechecking, the modified native-verifier script's typecheck, targeted lint, and whitespace checks passed. The maintainer did not request an Electron UI launch, and no packaging build was run.

## Recommendation

Use one shared description of the selected provider's supported features to drive Settings, configuration transitions, and recognition requests. Capabilities must depend on the selected model and output mode where necessary, rather than just the provider name.

Treat local formatting and local vocabulary as separate changes. CPU and CUDA are execution backends, not different feature sets. Parakeet already supports punctuation and capitalization and has an available hotword API. The pinned Granite model/runtime needs more work. Do not declare Granite vocabulary supported merely because the binding accepts a vocabulary argument.

The streaming provider in this repository is **WhisperLiveKit**. Only its adapter implements the app's live transcription contract. Other services may offer streaming APIs, but those APIs are not integrated here.

## Why local behavior differs

### Formatting

- `app/src/main/managed-local-model.ts` selects Parakeet unified English for CPU. `managed-local-catalog.ts` selects the same checkpoint in full precision for CUDA. NVIDIA documents built-in punctuation and capitalization for [Parakeet unified English](https://huggingface.co/nvidia/parakeet-unified-en-0.6b).
- `managed-local-decode.ts` returns the recognizer's text. `managed-local-runtime.ts` only trims it and optionally removes filler words. There is no application setting disabling punctuation or capitalization. The existing evaluation baseline also contains capitalized, punctuated local transcripts. This rules out a universal absence of formatting support, but does not explain a particular poorly formatted recording.
- Granite uses a pinned English TurboCTC GGUF with `transcribe-cpp` 0.4.1. The adapter calls `session.run` with English and no timestamps. The product already documents weaker formatting for this model in `app/docs/local-model-inference.md`.
- The [current Granite upstream checkpoint](https://huggingface.co/ibm-granite/granite-speech-5.0-470m-turboctc) gained punctuation/capitalization and multilingual support on 2026-10-21. Our GGUF is derived from an older checkpoint. Capabilities of the current upstream model cannot be attributed to the pinned artifact. Updating it requires verifying the converter, tokenizer, runtime, and CPU/CUDA outputs together.
- Corrected Dictation can already process a finalized local transcript through a separately configured formatter. It is optional and requires a separate endpoint. Its current prompt focuses on semantic cleanup and protected spellings, not explicit punctuation/capitalization restoration. It is not an automatic, bundled local formatting solution.

### Vocabulary

The missing wiring is definite:

1. Both the engine and worker adapter declare `dictionaryHints: false`.
2. Settings disables the Personal dictionary editor for Managed Local.
3. Main supplies `recognition.dictionary`, but the worker's `transcribe` and `incremental-start` messages do not carry it.
4. `decodeManagedLocal` calls `recognizer.createStream()` with no hotwords.
5. Parakeet's recognizer configuration does not enable contextual decoding or configure the tokenizer data needed for ordinary word hints.

The pinned Sherpa 2.0.1 implementation already exposes per-stream hotwords. They require transducer decoding with `modified_beam_search` and correct tokenization. See its [pinned implementation](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.1/scripts/node-addon-api/lib/non-streaming-asr.js) and [hotword documentation](https://k2-fsa.github.io/sherpa/onnx/hotwords/).

Granite TurboCTC is different. Its [pinned family implementation](https://github.com/handy-computer/transcribe.cpp/blob/v0.4.1/src/arch/granite5_ctc/capabilities.cpp) does not enable vocabulary support. The binding's generic `vocabulary` option only works for supporting families; elsewhere it is ignored with a warning. The [pinned prompting support list](https://github.com/handy-computer/transcribe.cpp/blob/v0.4.1/docs/prompting.md) lists other Granite families, not TurboCTC. Passing a glossary string will not fix this.

The separate `local-whisper-cpp` provider already sends the dictionary as a prompt. It should retain that behavior. WhisperLiveKit and Saaras v3 also lack dictionary hints in our adapters, so this gap is not exclusive to Managed Local.

## Confirmed configuration and UI discrepancies

| Area | Current behavior and evidence | Proposed behavior |
| --- | --- | --- |
| Live Dictation | `TranscriptionSettings.tsx` always lists it. `shared/dictation-runtime.ts` allows streaming only for WhisperLiveKit. | Hide Live for all other providers. Managed Local's speculative pause decoding remains Batch; it does not produce live committed/tentative text. |
| Live activation | Shortcuts always offers Push to Talk, then rejects it while Live is active. | In Live, offer Toggle only and explain the restriction. For WhisperLiveKit with Push to Talk, show an inline action to switch to Toggle before enabling Live. |
| Switching away from Live | `handleProviderChange` refuses a non-streaming provider because the old mode is still Live. | On an explicit provider change, atomically switch to Batch when necessary and show a short notice. Do not make users discover an order of operations. |
| Corrected setup | Selection is rejected until a valid formatter exists, but formatter fields render only when Corrected is selected. A fresh configuration cannot reach setup through this UI. | Make formatter setup reachable from Batch. Allow editing a draft and save it while Batch is active; enable Corrected only once setup is valid. |
| Corrected description | Copy says Live and Corrected need a supported provider. Corrected is actually an app-level postprocessing step available after every batch adapter. | Describe the formatter requirement separately from transcription-provider capabilities. |
| Task | Managed Local, Azure, Google, and WhisperLiveKit show a disabled Translate choice. NIM shows Translate even when its flag is false. | Show a task selector only when more than one task is supported. Respect NIM's selected capability flags. |
| Managed Local language | UI labels the only enabled choice Automatic language detection. Current Parakeet and Granite are English-only; Granite hardcodes English. Existing multilingual Parakeet installs are also supported as legacy artifacts. | Show a read-only language for monolingual artifacts. Resolve language behavior from the actual usable artifact, including legacy fallback, rather than the catalog's newest label. |
| Other language controls | Google keeps unsupported Auto visible but disabled. NIM leaves Auto selectable when disabled in its advanced capabilities. Most providers reuse the Whisper list regardless of model. | Remove unsupported Auto. Use provider/model language data where verified. Keep custom model restrictions explicit instead of claiming arbitrary slugs support every displayed language. |
| Dictionary | Unsupported editors remain visible for Managed Local, WhisperLiveKit, and Saaras v3. NIM's editor remains active even when its dictionary flag is false. | Hide unsupported recognition hints. Preserve the global saved terms; unsupported providers must omit them from requests rather than delete them or block unrelated recording. |
| Sarvam limits | V4 limits are checked after words are added; a dictionary saved under another provider can block readiness. | Validate additions before saving under v4. For an existing incompatible dictionary, show the limit error and an accessible editor to fix it. Never silently truncate or delete terms. Keep v3 terms dormant. |
| Clean transcription in Live | The toggle remains active, but WhisperLiveKit's streaming implementation never uses `removeFillerWords`; its batch implementation does. | Hide the control for Live. Do not rewrite text after it has already been inserted. Explain that saved cleanup preferences apply to Batch/Corrected. |
| Sarvam verbatim | UI already disables cleanup and the adapter correctly skips it. | Keep the behavior, hide the inapplicable switch, and retain a brief explanation. Task=Translate already hides the Sarvam-specific output selector and should continue to do so. |
| OpenAI model differences | `OPENAI_CAPABILITIES` claims translation and hints for every free-form model slug. | Resolve known models explicitly. The file translation endpoint supports only `whisper-1`, per [official OpenAI documentation](https://developers.openai.com/api/reference/typescript/resources/audio/subresources/translations/methods/create). Unknown endpoints/models must not inherit unverified capabilities. |
| Custom endpoints | Custom OpenAI-compatible providers unconditionally claim translation, auto detection, and hints. Compatibility with one API route does not establish all three. | Use a small explicit capability declaration, reusing the NIM approach for unknown servers. Preserve existing profiles through a documented migration rather than silently changing request behavior. No automatic network probes during render. |
| Google punctuation | `google-cloud-speech.ts` never sends automatic punctuation. Google documents it as opt-in, including sentence capitalization. | Request punctuation for supported model/language combinations. This is another formatting gap, separate from local inference. See [Google's documentation](https://docs.cloud.google.com/speech-to-text/docs/automatic-punctuation). |
| Shared validation | Recognition flags live in main adapters, transport flags in a shared table, and UI restrictions in repeated provider-name conditionals. `getRecognitionCompatibilityErrors` has no production caller. | Give UI and main one shared capability resolver. Validate supported active settings at the boundary; derive requests separately so dormant dictionary preferences do not cause errors. |
| Saving dependent changes | Provider changes save provider, task, and language separately. Persistence updates optimistically, swallows errors, and does not roll back; later saves can proceed after an earlier failure. | Save provider/model transitions and affected settings as one validated change. Apply the canonical response, or restore the last saved state on failure. |
| Setup checklist and status | Every non-WhisperLiveKit provider gets Set Whisper endpoint. Provider setup badges rely on field/credential presence; ADC can appear configured without credentials, and Managed Local readiness needs installed assets. | Derive setup guidance from the active provider and use accurate labels for configured, installed, reachable, and ready. Keep connectivity checks explicit. |
| Provider copy and privacy | WhisperLiveKit is described as Batch-only in selection copy. The footer only describes audio routing, while Corrected can send transcript text elsewhere. | Mention its implemented Live support. Compose the privacy explanation from the transcription endpoint plus the active formatter. |

These are source-confirmed mismatches in the app's current integration. This is not a claim that every API feature, cloud model/language combination, or remote deployment has been certified.

## Implementation plan

### 1. Centralize supported features and fix settings transitions

Extend the existing shared transcription/dictation helpers rather than adding a provider plugin framework. Resolve supported tasks, language selection, vocabulary mechanism and limits, cleanup availability, and transport from the active provider and relevant model configuration. Model fixed-language recognition separately from language detection. Derive Dictation modes from transport support plus the independent formatter setup.

Use this result in `TranscriptionSettings.tsx`, `ShortcutsSettings.tsx`, main readiness/config validation, and recognition request construction. Keep credentials and artifact paths in main. For managed models, include main-owned metadata for the actual installed/usable artifact in the existing model snapshot as needed.

Render only supported controls. Use read-only text when there is a single meaningful value. Use disabled controls for temporary prerequisites, such as a required download, with a direct setup action. Existing provider-specific credential/auth sections already conditionally render and should remain in place.

Add a narrowly scoped atomic configuration patch for transcription transitions. Main validates the entire candidate state before persisting and returns the canonical saved state. A provider switch can choose Batch/transcribe or an appropriate language when required, with an explicit UI notice. Changing NIM capability flags and Sarvam/local models must use the same transition logic. Do not change install-time defaults or introduce an unnecessary per-provider preference store.

Keep the saved dictionary independent of its use in a particular request. Unsupported adapters receive no hints. Existing incompatible imports/configurations get an actionable repair message rather than a blank selector or silent startup migration. Retain runtime guards for direct IPC calls and stale configuration.

### 2. Establish the local formatting baseline, then improve it

Use a small fixed audio set containing sentence boundaries, questions, acronyms, names, numbers, URLs, and quiet speech. Compare the returned recognizer text, cleaned text, and delivered Dictation text for Parakeet and Granite on CPU and CUDA. Cover both completed-WAV and incremental-finish paths. Record the actual artifact identity; include legacy Parakeet when installed.

For Parakeet, locate whether loss occurs in the model output, filler cleanup, or delivery before changing the model. If native output already contains the correct case and punctuation, fix the consuming stage. If native quality is the issue, evaluate decoding/checkpoint changes against the same audio. Do not apply blanket title casing or append periods to every utterance.

For Granite, first evaluate an explicitly pinned conversion of the newer punctuation/capitalization-capable checkpoint. Confirm compatibility with the native runtime and tokenizer on both backends before changing the manifest. Update native versions and matching CUDA artifacts together only if required. Use explicit downloads, hashes, staging, and retained previous artifacts, following the existing installer.

If a compatible formatting-capable Granite checkpoint cannot meet the quality/performance target, evaluate a small local punctuation-and-truecasing model in the existing utility process. A punctuation-only model is not sufficient. This is the fallback to a model update, not an additional model to ship by default. No cloud formatter or separate manually managed LLM should be required for ordinary local formatting.

Reuse the current optional Corrected formatter for users who want semantic cleanup. Make its capitalization/punctuation instructions explicit, preserve vocabulary spellings, and fix its setup flow, but do not make Corrected mode a prerequisite for normal local output.

### 3. Add real local vocabulary support

For Parakeet:

- Reuse the existing `dictionary: string[]` as the user-facing list of preferred terms.
- Snapshot terms once for the recording and pass them through validated worker messages for completed WAV and incremental start. Reuse that snapshot on speculative decodes and completed-WAV/CPU retry.
- Enable Sherpa contextual decoding when vocabulary is nonempty. Supply the matching BPE/tokenizer assets or a verified tokenization path. Treat current CPU, CUDA, and legacy artifacts separately where tokenizers differ.
- Supply per-stream hotwords on the initial decode and quiet-audio retry. Preserve the fast no-vocabulary path. If recognizer settings must change, do it between recordings and retain a single loaded recognizer rather than keeping multiple large models resident.
- Validate and bound terms before encoding. Plain user text must not accidentally become Sherpa phrase separators or boost-score syntax. Keep boost strength and beam width internal initially.
- Measure name-recognition gains, false insertions on unrelated speech, CPU/CUDA latency, and memory. A passing wiring test alone does not prove hotword quality.

For Granite, there is no equivalent app-only switch. To provide the same recognition-hint contract, add or adopt native TurboCTC contextual decoding, normally a lexicon/context graph with beam decoding over CTC emissions. Keep acoustic inference on the selected CPU/CUDA backend and use the same contextual decoder behavior for both. Expose it through the binding and update the pinned native libraries together. Verify real term recognition before advertising support.

Prefer an upstream implementation over maintaining a private decoder fork. This is the largest and least certain part of the work, and needs a short native feasibility investigation before committing a release estimate. It remains required for full vocabulary parity on Granite.

Exact spelling restoration can be a small shared final-text step for terms already recognized case-insensitively. It should respect word boundaries, preserve acronyms/URLs, and be idempotent. It cannot turn an unrelated misrecognition into the intended word. Explicit user-defined replacement pairs could be an optional separate feature, but must not be presented as recognition hints or substituted for the requested Granite vocabulary support.

### 4. Verify behavior at the owning boundaries

Use focused tests that protect observable behavior:

- Settings cannot select unsupported Live/task/language/hint options, including after model or NIM capability changes.
- A user can configure a formatter from an empty profile and then enable Corrected Dictation.
- Provider transitions leave one valid persisted configuration; a failed save restores the last saved selection and does not run subsequent partial saves.
- Saved vocabulary survives a switch to an unsupported provider and is omitted from its request. Sarvam v4 constraints are actionable without silently dropping terms.
- A recording keeps its original vocabulary through settings edits, incremental inference, quiet-audio retry, and Auto's CPU fallback. Cancellation cannot deliver stale results.
- Native audio checks establish improved vocabulary recognition and formatting on each local model/backend, with no material word-error, latency, or memory regression. CPU/CUDA transcripts need not be byte-identical.

Extend the strongest existing tests under `app/src/main/__tests__/` and the Settings component suite. Do not add tests that merely compare capability declarations to another copied table. Keep real model checks explicitly invoked outside default `bun test`.

Reuse `app/scripts/verify-local-models.ts` for native coverage and the existing evaluation scorer, which already reports punctuation/case errors separately. The native verifier currently only requires nonempty transcripts, so add meaningful expected formatting/vocabulary checks for the fixed audio set. Adapt the eval runner to the selected model/backend if needed rather than treating the current Parakeet-only runner as coverage for Granite.

Run targeted Bun tests and relevant app type/lint checks after implementation. A real Electron UI pass needs the maintainer's request, per project instructions. Update `app/CHANGELOG.md`, `app/CONTEXT.md`, and local inference documentation when the behavior ships. No packaging build is needed unless changing native release artifacts requires it.

## Delivery order and completion

1. Shared capability resolver, valid Settings selections, atomic transitions, and accessible Corrected setup. This can ship independently.
2. Local formatting baseline and the smallest proven Parakeet/Granite formatting improvements.
3. Parakeet vocabulary on CPU and CUDA, including fallback and incremental paths.
4. Granite native vocabulary work, after the feasibility investigation. Hiding its unsupported editor is only an interim UI correction, not completion of the vocabulary request.

Completion means both local model families produce properly formatted finalized Dictation and honor custom vocabulary on CPU and CUDA, and Settings cannot create known unsupported provider/model/mode combinations. Preserve Dictation without Agent Mode and the existing explicit download/fallback behavior throughout.

## Verification limits of this investigation

This plan comes from source inspection, existing checked-in evaluation results, and upstream model/library documentation. Dependencies, local model artifacts, and the audio dataset are absent from this checkout. No packages were installed, tests or native audio inference run, or Electron/browser sessions launched. The exact cause of a particular Parakeet formatting failure therefore remains to be reproduced; missing vocabulary transport and the listed UI restrictions are established directly by the source.
