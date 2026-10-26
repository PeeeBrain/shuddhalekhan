# On-device Parakeet on iPhone

Research checked October 26, 2026.

## Finding

Yes. FluidAudio's Core ML Parakeet TDT v3 runs offline on iOS 17+ after its model download, and its React Native wrapper exposes batch transcription from a file or an in-memory buffer. This fits the existing record-then-transcribe flow; streaming is unnecessary. The literal claim "fully on the Neural Engine" is too strong: FluidAudio defaults the encoder to CPU plus Neural Engine, pins preprocessing to CPU, and Core ML can schedule compatible operations on CPU. Apple documents this setting as allowing CPU and Neural Engine, not requiring exclusive Neural Engine execution. [FluidAudio model card](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml), [FluidAudio compute placement](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/ASR/EncoderComputePlacement.md), [Apple MLComputeUnits.cpuAndNeuralEngine](https://developer.apple.com/documentation/coreml/mlcomputeunits/cpuandneuralengine), [Apple Core ML performance analysis](https://developer.apple.com/documentation/coreml/analyzing-a-core-ml-model-s-performance-in-xcode).

The model runs locally once installed. V3 supports 25 European languages, not Indic languages. FluidAudio's current benchmark lists about 480 MB for v3 and reports first-load encoder compilation at about 3.4 seconds on iPhone 16 Pro Max and 4.4 seconds on iPhone 13. It does not publish a minimum RAM requirement. [Model card](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml), [benchmarks](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Benchmarks.md#asr-model-compilation).

## Official React Native wrapper

The official [`@fluidinference/react-native-fluidaudio`](https://github.com/FluidInference/react-native-fluidaudio) package is a React Native bridge over FluidAudio, not a JS implementation. Its README advertises iOS 17+, React Native 0.71+ / Expo SDK 50+, and describes development builds; Expo Go cannot load it. The module must be compiled into a custom native build, which can be a development or standalone Release build. The repo's current Expo 58 / React Native 0.88 versions satisfy the published peer-version floor, though the wrapper has not been built here.

Batch support is present: `ASRManager.transcribeFile(path)` and `transcribeBuffer(buffer, sampleRate)` call native FluidAudio. The wrapper's native initializer ignores its JS config and calls `AsrModels.downloadAndLoad()` with defaults, so the model is fixed to the default v3 rather than selectable. Its buffer path decodes signed 16-bit PCM but does not use the supplied sample rate or resample; only use it with 16 kHz audio. The existing 16 kHz PCM contract meets that constraint. The file path is safer for WAV/M4A because FluidAudio's file API performs audio conversion internally. [Wrapper JS source](https://github.com/FluidInference/react-native-fluidaudio/blob/main/src/FluidAudio.ts#L108-L146), [native source](https://github.com/FluidInference/react-native-fluidaudio/blob/main/ios/FluidAudioModule.swift#L127-L230), [FluidAudio file API](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/API.md#automatic-speech-recognition).

Two maintenance concerns remain. The podspec's CocoaPods constraint `FluidAudio ~> 0.7` permits any compatible pre-1.0 release, including 0.17.x, so the resolved FluidAudio version may not match the wrapper's original API assumptions. The wrapper's podspec also labels its native source "Legacy Bridge architecture only"; compatibility with this repo's React Native 0.88 architecture has not been verified. The wrapper repo package version is still `0.1.0`. [Podspec](https://github.com/FluidInference/react-native-fluidaudio/blob/main/react-native-fluidaudio.podspec), [package metadata](https://github.com/FluidInference/react-native-fluidaudio/blob/main/package.json).

## Windows and EAS

This is compatible with the Windows workflow. Expo says EAS Build can make iOS builds from any operating system; EAS compiles on a remote macOS VM, runs Prebuild for CNG projects, and runs CocoaPods. The custom native module needs a new native IPA build; Metro or an OTA JavaScript update cannot add it to the existing IPA. A standalone Release build works without Metro. [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/), [EAS iOS build process](https://docs.expo.dev/build-reference/ios-builds/), [Expo native module guidance](https://docs.expo.dev/workflow/customizing/).

## Repo history

This repo already has a smaller native integration in local history: `feat/210-ios-dictation` at `6ea91c2bdff1bb40d91789d2e328395c53274cb9` and follow-up `cebaf4cd6520b6327952a4380e4c6709b4bdf01d` contain a local Expo Modules Swift adapter around FluidAudio v0.15.5. Its README records a physical iOS 27 install where Parakeet downloaded and transcribed in Airplane Mode. That is a maintainer-recorded device check, not CI coverage. The associated [issue #210](https://github.com/PeeeBrain/shuddhalekhan/issues/210) remains open.

## Recommendation

The official wrapper covers this batch v3 use case, but its buffer-rate mismatch and fixed model choice are real limits. Since this repo's existing thin Expo adapter has already been exercised on an iPhone offline and lets the app explicitly pin v3/int8 and handle model state, that adapter is the better-supported local path here. Keep the app React Native/Expo; the small Swift module is only the iOS binding required to call FluidAudio.
