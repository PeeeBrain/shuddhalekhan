import AVFoundation
import ExpoModulesCore
import FluidAudio
import Foundation
import OSLog
import UIKit

private enum SpeechError: LocalizedError {
  case modelMissing
  case invalidRecording

  var errorDescription: String? {
    switch self {
    case .modelMissing:
      return "The Parakeet model is not installed. Install it before transcribing."
    case .invalidRecording:
      return "The recording must be an existing local file."
    }
  }
}

actor ParakeetEngine {
  static let shared = ParakeetEngine()
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "SpeechPerf")
  private var manager: AsrManager?
  private var managerModel: ParakeetModel?
  private let work = SpeechWorkQueue()

  func install(configuration: ParakeetConfiguration, progress: @escaping ProgressHandler) async throws {
    try await work.run {
      _ = try await self.loadManager(configuration: configuration, downloadIfMissing: true, progress: progress)
    }
  }

  func prepare(configuration: ParakeetConfiguration) async throws {
    try await work.run {
      _ = try await self.loadManager(configuration: configuration, downloadIfMissing: false)
    }
  }

  func transcribe(_ url: URL, configuration: ParakeetConfiguration) async throws -> String {
    try await work.run { try await self.transcribeRecording(url, configuration: configuration) }
  }

  private func transcribeRecording(_ url: URL, configuration: ParakeetConfiguration) async throws -> String {
    try Task.checkCancellation()
    let operation = UUID().uuidString
    let started = ProcessInfo.processInfo.systemUptime
    let cached = managerModel == configuration.model && manager != nil
    log.notice("SpeechPerf transcription id=\(operation, privacy: .public) stage=requested cached=\(cached, privacy: .public)")
    let manager = try await loadManager(configuration: configuration, downloadIfMissing: false)
    try Task.checkCancellation()

    var state = try TdtDecoderState()
    let text = try await manager.transcribe(
      url, decoderState: &state,
      language: configuration.model == .multilingual ? Language(rawValue: configuration.language) : nil
    ).text
    try Task.checkCancellation()
    let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1_000
    log.notice("SpeechPerf transcription id=\(operation, privacy: .public) stage=done elapsed_ms=\(elapsed, privacy: .public)")
    return text
  }

  private func loadManager(
    configuration: ParakeetConfiguration,
    downloadIfMissing: Bool,
    progress: ProgressHandler? = nil
  ) async throws -> AsrManager {
    if managerModel == configuration.model, let manager { return manager }
    // Keep only one encoder resident, including when switching languages.
    manager = nil
    managerModel = nil

    let started = ProcessInfo.processInfo.systemUptime
    log.notice("SpeechPerf model stage=requested")
    let version: AsrModelVersion = configuration.model == .english ? .v2 : .v3
    let directory = AsrModels.defaultCacheDirectory(for: version)
    let models: AsrModels
    if downloadIfMissing {
      models = try await AsrModels.downloadAndLoad(
        version: version,
        encoderPrecision: .int8,
        progressHandler: progress
      )
    } else {
      guard AsrModels.modelsExist(at: directory, version: version, encoderPrecision: .int8) else {
        throw SpeechError.modelMissing
      }
      models = try await AsrModels.load(
        from: directory,
        version: version,
        encoderPrecision: .int8
      )
    }

    // v3's mel prepend and parallel chunks can switch languages at chunk boundaries; v2 keeps FluidAudio's defaults.
    let config = configuration.model == .english ? ASRConfig.default : ASRConfig(parallelChunkConcurrency: 1, melChunkContext: false)
    let manager = AsrManager(config: config)
    try await manager.loadModels(models)
    let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1_000
    log.notice("SpeechPerf model stage=ready elapsed_ms=\(elapsed, privacy: .public)")
    self.manager = manager
    managerModel = configuration.model
    return manager
  }

}

public final class ShuddhalekhanSpeechModule: Module, @unchecked Sendable {
  private let engine = ParakeetEngine.shared
  @MainActor private var cues: RecordingCuePlayer { KeyboardSessionHost.sharedCues }
  @MainActor private var keyboardSession: KeyboardSessionHost { .shared }
  @MainActor private var foregroundLease: MicrophoneOwnership.Lease?
  @MainActor private var foregroundRecordingObservers: [NSObjectProtocol] = []
  @MainActor private var foregroundRecordingInterrupted = false

  public func definition() -> ModuleDefinition {
    Name("ShuddhalekhanSpeech")
    Events("onModelProgress", "onKeyboardSession", "onForegroundRecordingInterrupted", "onControlDictation")

    OnStartObserving("onControlDictation") {
      Task { @MainActor [weak self] in
        ControlDictationLaunch.onRequest = { [weak self] in self?.sendEvent("onControlDictation", [:]) }
      }
    }

    AsyncFunction("consumeControlDictation") { () async -> Bool in
      await ControlDictationLaunch.consume()
    }

    OnStartObserving("onKeyboardSession") {
      Task { @MainActor [weak self] in
        self?.keyboardSession.onChange = { [weak self] state in
          self?.sendEvent("onKeyboardSession", Self.payload(state))
        }
      }
    }

    AsyncFunction("initializeDictationPreferences") { (existingInstall: Bool) async throws in
      let hasInstalledModel = existingInstall || [AsrModelVersion.v2, .v3].contains { version in
        let directory = AsrModels.defaultCacheDirectory(for: version)
        return AsrModels.modelsExist(at: directory, version: version, encoderPrecision: .int8)
      }
      _ = try await DictationSettings.initialize(existingInstall: hasInstalledModel)
      await SystemDictation.recoverActivities()
    }

    AsyncFunction("getDictationPreferences") { () async -> [String: Any] in
      Self.preferencesPayload(await DictationSettings.preferences)
    }

    AsyncFunction("updateDictationPreferences") { (json: String) async throws -> [String: Any] in
      Self.preferencesPayload(try await Self.updatePreferences(json))
    }

    AsyncFunction("getDictationReadiness") { () async -> [String: String] in
      await self.dictationReadiness()
    }

    AsyncFunction("requestDictationMicrophone") { () async -> Bool in
      await AVAudioApplication.requestRecordPermission()
    }

    AsyncFunction("setDictationModelLanguage") { (language: String) async in
      await MainActor.run { DictationSettings.language = language }
    }

    AsyncFunction("formatDictation") { (text: String, snapshot: String, language: String) async throws -> String in
      guard snapshot.utf8.count <= 32_768 else { throw DictationPreferenceError.invalid }
      let preferences = try JSONDecoder().decode(DictationPreferences.self, from: Data(snapshot.utf8)).validated()
      return await DictationCleanup.format(text, preferences: preferences, language: language)
    }

    AsyncFunction("consumeSystemDictation") { () async -> String? in
      await SystemDictation.shared.takeUncopiedResult()
    }

    AsyncFunction("releaseForegroundRecording") { () async in
      await self.releaseForegroundRecording()
    }

    AsyncFunction("signGoogleJwt") { (privateKey: String, input: String) throws -> String in
      try GoogleJwt.sign(privateKey: privateKey, input: input)
    }

    AsyncFunction("getRecordingSounds") { () async -> Bool in
      await self.cues.enabled
    }

    AsyncFunction("setRecordingSounds") { (enabled: Bool) async in
      await MainActor.run { self.cues.enabled = enabled }
    }

    AsyncFunction("beginForegroundRecording") { () async -> Bool in
      await self.beginForegroundRecording()
    }

    AsyncFunction("getForegroundRecordingInterrupted") { () async -> Bool in
      await self.foregroundRecordingInterrupted
    }

    AsyncFunction("playForegroundRecordingCue") { (name: String) async -> Bool in
      guard let cue = RecordingCue(rawValue: name) else { return true }
      return await self.playForegroundCue(cue, in: .foreground)
    }

    AsyncFunction("previewRecordingCue") { () async in
      _ = await self.playForegroundCue(.start, in: .preview)
    }

    AsyncFunction("cancelForegroundRecordingCue") { () async -> Bool in
      await MainActor.run {
        self.endForegroundRecording()
        if MicrophoneOwnership.shared.owner == .foreground { self.cues.stop() }
        return self.foregroundRecordingInterrupted
      }
    }

    AsyncFunction("getKeyboardSession") { () async -> [String: Any] in
      Self.payload(await self.keyboardSession.state)
    }

    AsyncFunction("startKeyboardSession") { (minutes: Int, language: String, agentReady: Bool) async throws -> [String: Any] in
      try await self.keyboardSession.start(minutes: minutes, configuration: ParakeetConfiguration(language: language), agentReady: agentReady)
      return Self.payload(await self.keyboardSession.state)
    }

    AsyncFunction("resolveKeyboardAgentRequest") { (id: String, error: String?) async in
      await self.keyboardSession.resolveAgent(id, error: error)
    }

    AsyncFunction("stopKeyboardSession") { () async in
      await self.keyboardSession.end()
    }

    AsyncFunction("getModelState") { (language: String) throws -> String in
      let configuration = try ParakeetConfiguration(language: language)
      let version: AsrModelVersion = configuration.model == .english ? .v2 : .v3
      let directory = AsrModels.defaultCacheDirectory(for: version)
      return AsrModels.modelsExist(at: directory, version: version, encoderPrecision: .int8)
        ? "ready" : "missing"
    }

    AsyncFunction("prepareModel") { (language: String) async throws in
      try await self.engine.prepare(configuration: ParakeetConfiguration(language: language))
    }

    AsyncFunction("installModel") { (language: String) async throws in
      try await self.engine.install(configuration: ParakeetConfiguration(language: language)) { [weak self] progress in
        let phase: String
        switch progress.phase {
        case .compiling(_): phase = "installing"
        case .listing, .downloading(_, _): phase = "downloading"
        }
        Task { @MainActor in
          self?.sendEvent("onModelProgress", [
            "phase": phase,
            "fraction": progress.fractionCompleted
          ])
        }
      }
    }

    AsyncFunction("transcribe") { (uri: String, language: String) async throws -> String in
      guard let url = URL(string: uri),
            url.isFileURL,
            (url.host == nil || url.host == "" || url.host == "localhost"),
            url.path.hasPrefix("/"),
            url.query == nil,
            url.fragment == nil else {
        throw SpeechError.invalidRecording
      }

      let fileURL = url.standardizedFileURL
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory),
            !isDirectory.boolValue else {
        throw SpeechError.invalidRecording
      }
      return try await self.engine.transcribe(fileURL, configuration: ParakeetConfiguration(language: language))
    }
  }

  @MainActor private func beginForegroundRecording() -> Bool {
    guard UIApplication.shared.applicationState != .background,
          let lease = try? MicrophoneOwnership.shared.claim(.foreground) else { return false }
    foregroundLease = lease
    cues.stop()
    endForegroundRecording()
    foregroundRecordingInterrupted = false
    let center = NotificationCenter.default
    let background = UIApplication.didEnterBackgroundNotification
    foregroundRecordingObservers = [
      AVAudioSession.interruptionNotification, AVAudioSession.mediaServicesWereResetNotification, background,
    ].map { name in
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
        guard !notification.isAudioInterruptionEnd else { return }
        let notify = name != background
        MainActor.assumeIsolated {
          guard let self, !self.foregroundRecordingInterrupted else { return }
          self.foregroundRecordingInterrupted = true
          if notify { self.sendEvent("onForegroundRecordingInterrupted", [:]) }
        }
      }
    }
    return true
  }

  @MainActor private func endForegroundRecording() {
    for observer in foregroundRecordingObservers { NotificationCenter.default.removeObserver(observer) }
    foregroundRecordingObservers.removeAll()
  }

  @MainActor private func playForegroundCue(_ cue: RecordingCue, in context: RecordingCuePlayer.Context) async -> Bool {
    let preparing = context == .foreground && cue == .start
    let owner = MicrophoneOwnership.shared.owner
    guard owner == nil || owner == .foreground, UIApplication.shared.applicationState != .background,
          !preparing || !foregroundRecordingInterrupted else { return false }
    // The permission dialog can leave the app briefly inactive without interrupting its microphone.
    guard UIApplication.shared.applicationState == .active else { return true }
    let played = await cues.play(cue, in: context)
    return played && (!preparing || !foregroundRecordingInterrupted)
  }

  @MainActor private func releaseForegroundRecording() {
    endForegroundRecording()
    if let foregroundLease { MicrophoneOwnership.shared.release(foregroundLease) }
    foregroundLease = nil
  }

  @MainActor private func dictationReadiness() -> [String: String] {
    let verifiedForMs = keyboardSession.keyboardVerifiedForMs
    let verified = verifiedForMs > 0 ? "verified" : "unverified"
    let microphone: String
    switch AVAudioApplication.shared.recordPermission {
    case .granted: microphone = "granted"
    case .denied: microphone = "denied"
    case .undetermined: microphone = "undetermined"
    @unknown default: microphone = "undetermined"
    }
    let reason = DictationCleanup.unavailableReason(language: DictationSettings.language ?? "")
    var readiness = ["keyboard": verified, "fullAccess": verified, "microphone": microphone,
      "keyboardVerifiedForMs": String(verifiedForMs), "cleanup": reason == nil ? "available" : "unavailable"]
    readiness["cleanupReason"] = reason
    return readiness
  }

  @MainActor private static func updatePreferences(_ json: String) throws -> DictationPreferences {
    struct Patch: Decodable {
      let style: DictationStyle?
      let vocabularyEnabled: Bool?
      let vocabulary: [String]?
      let sessionMinutes: Int?
      let cleanupEnabled: Bool?
    }
    guard json.utf8.count <= 32_768 else { throw DictationPreferenceError.invalid }
    let patch = try JSONDecoder().decode(Patch.self, from: Data(json.utf8))
    var preferences = DictationSettings.preferences
    if let style = patch.style { preferences.style = style }
    if let enabled = patch.vocabularyEnabled { preferences.vocabularyEnabled = enabled }
    if let vocabulary = patch.vocabulary { preferences.vocabulary = vocabulary }
    if let minutes = patch.sessionMinutes { preferences.sessionMinutes = minutes }
    if let enabled = patch.cleanupEnabled { preferences.cleanupEnabled = enabled }
    try DictationSettings.save(preferences)
    KeyboardSessionHost.shared.refreshStyle()
    return DictationSettings.preferences
  }

  private static func preferencesPayload(_ preferences: DictationPreferences) -> [String: Any] {
    ["style": preferences.style.rawValue, "vocabularyEnabled": preferences.vocabularyEnabled,
     "vocabulary": preferences.vocabulary, "sessionMinutes": preferences.sessionMinutes,
     "cleanupEnabled": preferences.cleanupEnabled]
  }

  private static func payload(_ state: KeyboardSession.State) -> [String: Any] {
    var payload: [String: Any] = ["endsAt": Double(state.sessionEndsAt), "phase": state.phase.rawValue,
      "agentReady": state.agentReady]
    if let id = state.requestId { payload["requestId"] = id }
    if let mode = state.mode { payload["mode"] = mode.rawValue }
    if let text = state.text { payload["text"] = text }
    if let error = state.error { payload["error"] = error }
    return payload
  }
}
