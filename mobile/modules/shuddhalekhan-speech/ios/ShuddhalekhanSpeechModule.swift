import ExpoModulesCore
import FluidAudio
import Foundation
import OSLog

private enum SpeechError: LocalizedError {
  case modelMissing
  case invalidRecording
  case busy

  var errorDescription: String? {
    switch self {
    case .modelMissing:
      return "The Parakeet model is not installed. Install it before transcribing."
    case .invalidRecording:
      return "The recording must be an existing local file."
    case .busy:
      return "Parakeet is already transcribing a recording."
    }
  }
}

actor ParakeetEngine {
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "SpeechPerf")
  private var manager: AsrManager?
  private var managerModel: ParakeetModel?
  private var managerLoad: (model: ParakeetModel, task: Task<AsrManager, Error>)?
  private var inferenceInProgress = false

  func install(configuration: ParakeetConfiguration, progress: @escaping ProgressHandler) async throws {
    _ = try await loadManager(configuration: configuration, downloadIfMissing: true, progress: progress)
  }

  func prepare(configuration: ParakeetConfiguration) async throws {
    _ = try await loadManager(configuration: configuration, downloadIfMissing: false)
  }

  func transcribe(_ url: URL, configuration: ParakeetConfiguration) async throws -> String {
    guard !inferenceInProgress else { throw SpeechError.busy }
    inferenceInProgress = true
    defer { inferenceInProgress = false }
    let operation = UUID().uuidString
    let started = ProcessInfo.processInfo.systemUptime
    let cached = managerModel == configuration.model && manager != nil
    log.notice("SpeechPerf transcription id=\(operation, privacy: .public) stage=requested cached=\(cached, privacy: .public)")
    let manager = try await loadManager(configuration: configuration, downloadIfMissing: false)

    var state = try TdtDecoderState()
    let text = try await manager.transcribe(
      url, decoderState: &state,
      language: configuration.model == .multilingual ? Language(rawValue: configuration.language) : nil
    ).text
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
    if let managerLoad {
      guard managerLoad.model == configuration.model else { throw SpeechError.busy }
      return try await managerLoad.task.value
    }
    // Keep only one encoder resident, including when switching languages.
    manager = nil
    managerModel = nil

    let task = Task<AsrManager, Error> {
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
      return manager
    }
    managerLoad = (configuration.model, task)

    do {
      let manager = try await task.value
      self.manager = manager
      managerModel = configuration.model
      managerLoad = nil
      return manager
    } catch {
      managerLoad = nil
      throw error
    }
  }

}

public final class ShuddhalekhanSpeechModule: Module, @unchecked Sendable {
  private let engine = ParakeetEngine()
  @MainActor private var keyboardSession: KeyboardSessionHost?

  public func definition() -> ModuleDefinition {
    Name("ShuddhalekhanSpeech")
    Events("onModelProgress", "onKeyboardSession")

    AsyncFunction("signGoogleJwt") { (privateKey: String, input: String) throws -> String in
      try GoogleJwt.sign(privateKey: privateKey, input: input)
    }

    AsyncFunction("getKeyboardSession") { () async -> [String: Any] in
      Self.payload(await self.sessionHost().state)
    }

    AsyncFunction("startKeyboardSession") { (minutes: Int, language: String) async throws -> [String: Any] in
      try await self.sessionHost().start(minutes: minutes, configuration: ParakeetConfiguration(language: language))
      return Self.payload(await self.sessionHost().state)
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

  @MainActor private func sessionHost() -> KeyboardSessionHost {
    if let keyboardSession { return keyboardSession }
    let host = KeyboardSessionHost(speech: engine) { [weak self] state in
      self?.sendEvent("onKeyboardSession", Self.payload(state))
    }
    keyboardSession = host
    return host
  }

  private static func payload(_ state: KeyboardSession.State) -> [String: Any] {
    var payload: [String: Any] = ["endsAt": Double(state.sessionEndsAt), "phase": state.phase.rawValue]
    if let error = state.error { payload["error"] = error }
    return payload
  }
}
