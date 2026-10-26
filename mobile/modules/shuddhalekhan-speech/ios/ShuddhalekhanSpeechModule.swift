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
  private var managerLoad: Task<AsrManager, Error>?
  private var inferenceInProgress = false

  func install(progress: @escaping ProgressHandler) async throws {
    _ = try await loadManager(downloadIfMissing: true, progress: progress)
  }

  func prepare() async throws {
    _ = try await loadManager(downloadIfMissing: false)
  }

  func transcribe(_ url: URL) async throws -> String {
    guard !inferenceInProgress else { throw SpeechError.busy }
    inferenceInProgress = true
    defer { inferenceInProgress = false }
    let operation = UUID().uuidString
    let started = ProcessInfo.processInfo.systemUptime
    let cached = manager != nil
    log.notice("SpeechPerf transcription id=\(operation, privacy: .public) stage=requested cached=\(cached, privacy: .public)")
    let manager = try await loadManager(downloadIfMissing: false)

    var state = try TdtDecoderState()
    let text = try await manager.transcribe(url, decoderState: &state).text
    let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1_000
    log.notice("SpeechPerf transcription id=\(operation, privacy: .public) stage=done elapsed_ms=\(elapsed, privacy: .public)")
    return text
  }

  private func loadManager(
    downloadIfMissing: Bool,
    progress: ProgressHandler? = nil
  ) async throws -> AsrManager {
    if let manager { return manager }
    if let managerLoad {
      let manager = try await managerLoad.value
      self.manager = manager
      return manager
    }

    let task = Task<AsrManager, Error> {
      let started = ProcessInfo.processInfo.systemUptime
      log.notice("SpeechPerf model stage=requested")
      let directory = AsrModels.defaultCacheDirectory(for: .v3)
      let models: AsrModels
      if downloadIfMissing {
        models = try await AsrModels.downloadAndLoad(
          version: .v3,
          encoderPrecision: .int8,
          progressHandler: progress
        )
      } else {
        guard AsrModels.modelsExist(at: directory, version: .v3, encoderPrecision: .int8) else {
          throw SpeechError.modelMissing
        }
        models = try await AsrModels.load(
          from: directory,
          version: .v3,
          encoderPrecision: .int8
        )
      }

      let manager = AsrManager()
      try await manager.loadModels(models)
      let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1_000
      log.notice("SpeechPerf model stage=ready elapsed_ms=\(elapsed, privacy: .public)")
      return manager
    }
    managerLoad = task

    do {
      let manager = try await task.value
      self.manager = manager
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

    AsyncFunction("getKeyboardSession") { () async -> [String: Any] in
      Self.payload(await self.sessionHost().state)
    }

    AsyncFunction("startKeyboardSession") { (minutes: Int) async throws -> [String: Any] in
      try await self.sessionHost().start(minutes: minutes)
      return Self.payload(await self.sessionHost().state)
    }

    AsyncFunction("stopKeyboardSession") { () async in
      await self.sessionHost().end()
    }

    AsyncFunction("getModelState") { () -> String in
      let directory = AsrModels.defaultCacheDirectory(for: .v3)
      return AsrModels.modelsExist(at: directory, version: .v3, encoderPrecision: .int8)
        ? "ready" : "missing"
    }

    AsyncFunction("prepareModel") { () async throws in
      try await self.engine.prepare()
    }

    AsyncFunction("installModel") { () async throws in
      try await self.engine.install { [weak self] progress in
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

    AsyncFunction("transcribe") { (uri: String) async throws -> String in
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
      return try await self.engine.transcribe(fileURL)
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
