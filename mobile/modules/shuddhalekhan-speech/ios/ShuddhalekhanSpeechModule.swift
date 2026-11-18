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
  private let engine = ParakeetEngine()
  @MainActor private lazy var cues = RecordingCuePlayer()
  @MainActor private var keyboardSession: KeyboardSessionHost?
  @MainActor private var foregroundRecordingObservers: [NSObjectProtocol] = []
  @MainActor private var foregroundRecordingInterrupted = false

  public func definition() -> ModuleDefinition {
    Name("ShuddhalekhanSpeech")
    Events("onModelProgress", "onKeyboardSession", "onForegroundRecordingInterrupted")

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
        if self.keyboardSession?.ownsAudio != true { self.cues.stop() }
        return self.foregroundRecordingInterrupted
      }
    }

    AsyncFunction("getKeyboardSession") { () async -> [String: Any] in
      Self.payload(await self.sessionHost().state)
    }

    AsyncFunction("startKeyboardSession") { (minutes: Int, language: String, agentReady: Bool) async throws -> [String: Any] in
      try await self.sessionHost().start(minutes: minutes, configuration: ParakeetConfiguration(language: language), agentReady: agentReady)
      return Self.payload(await self.sessionHost().state)
    }

    AsyncFunction("resolveKeyboardAgentRequest") { (id: String, error: String?) async in
      await self.sessionHost().resolveAgent(id, error: error)
    }

    AsyncFunction("stopKeyboardSession") { () async in
      await self.sessionHost().end()
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
    guard keyboardSession?.ownsAudio != true, UIApplication.shared.applicationState != .background else { return false }
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
    guard keyboardSession?.ownsAudio != true, UIApplication.shared.applicationState != .background,
          !preparing || !foregroundRecordingInterrupted else { return false }
    // The permission dialog can leave the app briefly inactive without interrupting its microphone.
    guard UIApplication.shared.applicationState == .active else { return true }
    let played = await cues.play(cue, in: context)
    return played && (!preparing || !foregroundRecordingInterrupted)
  }

  @MainActor private func sessionHost() -> KeyboardSessionHost {
    if let keyboardSession { return keyboardSession }
    let host = KeyboardSessionHost(speech: engine, cues: cues) { [weak self] state in
      self?.sendEvent("onKeyboardSession", Self.payload(state))
    }
    keyboardSession = host
    return host
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
