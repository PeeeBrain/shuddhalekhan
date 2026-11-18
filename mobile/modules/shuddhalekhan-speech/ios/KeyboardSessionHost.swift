import AVFoundation
import UIKit
import OSLog

enum KeyboardSessionError: LocalizedError {
  case invalidDuration
  case microphoneDenied
  case noInput
  case bridgeUnavailable

  var errorDescription: String? {
    switch self {
    case .invalidDuration: return "Keyboard sessions last 1 to 30 minutes."
    case .microphoneDenied: return "Microphone access is denied. Enable it for Shuddhalekhan in iOS Settings."
    case .noInput: return "No microphone input is available."
    case .bridgeUnavailable: return "Could not connect the dictation keyboard. Keep Shuddhalekhan open while starting a session."
    }
  }
}

/// A bounded keyboard dictation session, started by the user in the foreground app.
/// While it lasts the app keeps the microphone open (iOS shows the recording indicator) so the keyboard can
/// start and stop utterances from another app. Audio is only written between a keyboard start and stop/cancel;
/// everything else is dropped in the tap. Transcription runs here with Parakeet, never in the keyboard.
@MainActor
final class KeyboardSessionHost {
  private static let maxUtteranceSeconds: TimeInterval = 120

  private let speech: ParakeetEngine
  private var configuration: ParakeetConfiguration?
  private let onChange: @MainActor (KeyboardSession.State) -> Void
  private static let tapFrames: AVAudioFrameCount = 4_096
  private let audio = AVAudioEngine()
  private let cues: RecordingCuePlayer
  private let sink = KeyboardUtteranceSink()
  private let recordings = KeyboardAudioStore()
  private(set) var state = KeyboardSession.State.ended
  private var starting = false
  var ownsAudio: Bool { starting || state.sessionEndsAt != 0 }
  private var preparingUtterance: Task<Void, Never>?
  private var failureCue: Task<Void, Never>?
  private var endWhenIdle = false
  private var endTimer: Timer?
  private var utteranceTimer: Timer?
  private var levelTimer: Timer?
  private var pendingAgent: KeyboardSession.State?
  private var handoffTimeout: Task<Void, Never>?
  private var utteranceURL: URL?
  private var transcription: (id: String, task: Task<Void, Never>)?
  private var observers: [NSObjectProtocol] = []
  private let server = KeyboardSessionServer()
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "KeyboardBridge")

  init(speech: ParakeetEngine, cues: RecordingCuePlayer, onChange: @escaping @MainActor (KeyboardSession.State) -> Void) {
    self.speech = speech
    self.cues = cues
    self.onChange = onChange
    server.onCommand = { [weak self] command in self?.handleCommand(command) }
    server.onFailure = { [weak self] in self?.end(reason: "The keyboard connection stopped. Start a new session.") }
  }

  func start(minutes: Int, configuration: ParakeetConfiguration, agentReady: Bool) async throws {
    guard (1...30).contains(minutes) else { throw KeyboardSessionError.invalidDuration }
    guard !ownsAudio else { return }
    starting = true
    defer { starting = false }

    let operation = UUID().uuidString
    let started = ProcessInfo.processInfo.systemUptime
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
    func mark(_ stage: String) {
      let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1_000
      log.notice("SpeechPerf session id=\(operation, privacy: .public) build=\(build, privacy: .public) stage=\(stage, privacy: .public) elapsed_ms=\(elapsed, privacy: .public)")
    }
    mark("requested")

    guard await AVAudioApplication.requestRecordPermission() else { throw KeyboardSessionError.microphoneDenied }
    mark("permission")
    // Load Parakeet now so the first utterance is not a cold load while the app is in the background.
    try await speech.prepare(configuration: configuration)
    self.configuration = configuration
    mark("model_ready")

    guard UIApplication.shared.applicationState == .active else { throw KeyboardSessionError.bridgeUnavailable }
    let session = AVAudioSession.sharedInstance()
    cues.stop()
    // A2DP adds Bluetooth output while retaining the keyboard's existing input routes.
    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
    mark("category_set")
    try session.setActive(true)
    mark("audio_active")
    let input = audio.inputNode
    let format = input.outputFormat(forBus: 0)
    mark("input_ready")
    guard format.sampleRate > 0, format.channelCount > 0 else {
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      throw KeyboardSessionError.noInput
    }
    input.installTap(onBus: 0, bufferSize: Self.tapFrames, format: format, block: Self.tap(into: sink))
    mark("tap_installed")
    do {
      try audio.start()
      mark("engine_started")
    } catch {
      input.removeTap(onBus: 0)
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      throw error
    }

    let endsAt = Date().addingTimeInterval(TimeInterval(minutes * 60))
    do {
      let bridge = try await server.start(expiresAt: KeyboardSession.nowMs(endsAt))
      mark("listener_ready")
      guard UIApplication.shared.applicationState == .active,
            let board = UIPasteboard(name: UIPasteboard.Name(KeyboardSession.discoveryPasteboard), create: true),
            let payload = KeyboardSession.encode(bridge) else { throw KeyboardSessionError.bridgeUnavailable }
      // Publish discovery while the app is foregrounded; iOS denies background pasteboard access.
      board.setData(payload, forPasteboardType: KeyboardSession.payloadType)
      guard board.data(forPasteboardType: KeyboardSession.payloadType) == payload else {
        throw KeyboardSessionError.bridgeUnavailable
      }
    } catch {
      server.stop()
      input.removeTap(onBus: 0)
      audio.stop()
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      throw error
    }
    observeSystem()
    endTimer = Timer.scheduledTimer(withTimeInterval: endsAt.timeIntervalSinceNow, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.expire() }
    }
    publish(KeyboardSession.State(
      sessionEndsAt: KeyboardSession.nowMs(endsAt), requestId: nil, mode: nil, agentReady: agentReady,
      phase: .idle, text: nil, error: nil, level: nil))
    NotificationCenter.default.post(name: Notification.Name("ShuddhalekhanKeyboardSessionActive"), object: nil,
      userInfo: ["active": true, "agentReady": agentReady, "endsAt": endsAt])
    mark("ready")
  }

  /// Ends the session now. An utterance in flight is discarded and the keyboard sees the session end.
  func end(reason: String? = nil, completed: KeyboardSession.State? = nil) {
    guard state.sessionEndsAt != 0 else { return }
    if UIApplication.shared.applicationState == .active,
      let board = UIPasteboard(name: UIPasteboard.Name(KeyboardSession.discoveryPasteboard), create: false) {
      board.items = []
    }
    // An agent run still awaiting admission must be cancelled in JS, not left to start after the session ends.
    let completed = completed ?? pendingAgent.map { $0.with(.cancelled, requestId: $0.requestId) }
    endTimer?.invalidate()
    endTimer = nil
    endWhenIdle = false
    discardUtterance()
    audio.inputNode.removeTap(onBus: 0)
    audio.stop()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    publish(KeyboardSession.State(
      sessionEndsAt: 0, requestId: completed?.requestId, mode: completed?.mode, agentReady: false,
      phase: completed?.phase ?? .idle, text: completed?.text, error: reason ?? completed?.error, level: nil))
    server.stop(final: state)
    NotificationCenter.default.post(name: Notification.Name("ShuddhalekhanKeyboardSessionActive"), object: nil,
      userInfo: ["active": false])
  }

  private func expire() {
    // Let a started utterance finish; the utterance cap keeps this bounded.
    if state.phase == .recording || state.phase == .transcribing {
      endWhenIdle = true
      cues.stop()
    } else { end() }
  }

  private func handleCommand(_ command: KeyboardSession.Command) {
    guard let next = KeyboardSession.transition(state, on: command, now: KeyboardSession.nowMs()) else { return }
    switch next.phase {
    case .preparing: beginUtterance(next)
    case .transcribing: finishUtterance(next)
    case .cancelled:
      discardUtterance()
      settle(next)
    case .failed: settle(next)
    default: break
    }
  }

  private func beginUtterance(_ next: KeyboardSession.State) {
    guard let id = next.requestId else { return }
    failureCue?.cancel()
    cues.stop()
    do {
      let url = try recordings.recordingURL()
      utteranceURL = url
      try sink.prepare(url, format: audio.inputNode.outputFormat(forBus: 0))
    } catch {
      discardUtterance()
      fail(next, message: "Could not open temporary audio. Check available storage and try again.")
      return
    }
    publish(next)
    if !cues.enabled {
      openCapture(id)
      return
    }
    preparingUtterance = Task {
      guard KeyboardSession.captureReady(state, requestId: id, now: KeyboardSession.nowMs()) != nil else {
        openCapture(id)
        return
      }
      let canStart = await cues.play(.start, in: .keyboard)
      guard !Task.isCancelled else { return }
      guard canStart else {
        end(reason: "The microphone was interrupted.")
        return
      }
      preparingUtterance = nil
      openCapture(id)
    }
  }

  private func openCapture(_ id: String) {
    guard let next = KeyboardSession.captureReady(state, requestId: id, now: KeyboardSession.nowMs()) else {
      if state.phase == .preparing, state.requestId == id { end() }
      return
    }
    sink.start(at: mach_absolute_time())
    levelTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.state.phase == .recording, let level = self.sink.currentLevel() else { return }
        // Levels go only to the socket. Never call publish/onChange on this path.
        self.server.publish(self.state.with(.recording, requestId: self.state.requestId, level: level))
      }
    }
    utteranceTimer = Timer.scheduledTimer(withTimeInterval: Self.maxUtteranceSeconds, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.state.phase == .recording else { return }
        self.finishUtterance(self.state.with(.transcribing, requestId: self.state.requestId))
      }
    }
    publish(next)
  }

  private func finishUtterance(_ next: KeyboardSession.State) {
    levelTimer?.invalidate()
    levelTimer = nil
    utteranceTimer?.invalidate()
    utteranceTimer = nil
    guard let url = utteranceURL, let id = next.requestId, let configuration else {
      discardUtterance()
      fail(next, message: "The recording could not be saved.")
      return
    }
    let stop = mach_absolute_time()
    sink.markStop(at: stop)
    publish(next)
    let task = Task { [speech, configuration] in
      defer { if transcription?.id == id { transcription = nil } }
      // AVAudioEngine may deliver up to 400 ms per tap. Normally the next tap closes the file.
      let saved = await sink.drain(until: stop, timeout: .milliseconds(650))
      guard !Task.isCancelled else { return }
      utteranceURL = nil
      defer { recordings.remove(url) }
      guard saved else {
        fail(next, message: "The recording could not be saved.")
        return
      }
      async let stopSound: Void = playStopIfLive(id)
      let result: Result<String, Error>
      do { result = .success(try await speech.transcribe(url, configuration: configuration)) } catch { result = .failure(error) }
      await stopSound
      if !Task.isCancelled { self.complete(id, result) }
    }
    transcription = (id, task)
  }

  private func playStopIfLive(_ id: String) async {
    guard state.requestId == id, state.phase == .transcribing, state.isLive(now: KeyboardSession.nowMs()) else { return }
    _ = await cues.play(.stop, in: .keyboard)
  }

  private func complete(_ id: String, _ result: Result<String, Error>) {
    // A cancel, a newer request, or a session end already moved on; drop the stale result.
    guard state.requestId == id, state.phase == .transcribing else { return }
    switch result {
    case .success(let raw):
      let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty {
        fail(state, message: "No speech was recognized.")
      } else if text.utf8.count > KeyboardSession.maxTextBytes {
        fail(state, message: "The transcript is too large.")
      } else {
        let done = state.with(.done, requestId: id, text: text)
        if state.mode == .agent {
          guard !endWhenIdle else {
            settle(state.with(.failed, requestId: id, error: "The session expired. Start a new session to ask the agent."))
            return
          }
          // JS must admit the run before the keyboard says it was sent. Keep socket state transcribing.
          pendingAgent = done
          onChange(done)
          handoffTimeout = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            self?.resolveAgent(id, error: "The agent did not start. Open Shuddhalekhan and try again.")
          }
        } else { settle(done) }
      }
    case .failure:
      fail(state, message: "Parakeet could not transcribe this recording.")
    }
  }

  func resolveAgent(_ id: String, error: String?) {
    guard let pending = pendingAgent, pending.requestId == id, state.requestId == id,
      state.phase == .transcribing else { return }
    pendingAgent = nil
    handoffTimeout?.cancel()
    handoffTimeout = nil
    settle(error.map {
      pending.with(.failed, requestId: id, error: String(decoding: $0.utf8.prefix(400), as: UTF8.self))
    } ?? pending)
  }

  private func fail(_ request: KeyboardSession.State, message: String) {
    let failed = request.with(.failed, requestId: request.requestId, error: message)
    settle(failed)
    guard state == failed, state.isLive(now: KeyboardSession.nowMs()) else { return }
    failureCue = Task {
      guard state == failed, state.isLive(now: KeyboardSession.nowMs()) else { return }
      _ = await cues.play(.error, in: .keyboard)
    }
  }

  /// Publishes a terminal request state, then honours a session expiry that arrived mid-utterance.
  private func settle(_ next: KeyboardSession.State) {
    // Keep the final result readable after releasing the microphone at session expiry.
    if endWhenIdle { end(completed: next) } else { publish(next) }
  }

  private func discardUtterance() {
    preparingUtterance?.cancel()
    preparingUtterance = nil
    failureCue?.cancel()
    failureCue = nil
    cues.stop()
    pendingAgent = nil
    handoffTimeout?.cancel()
    handoffTimeout = nil
    levelTimer?.invalidate()
    levelTimer = nil
    transcription?.task.cancel()
    transcription = nil
    utteranceTimer?.invalidate()
    utteranceTimer = nil
    sink.discard()
    if let url = utteranceURL { recordings.remove(url) }
    utteranceURL = nil
  }

  private func publish(_ next: KeyboardSession.State) {
    state = next
    log.notice("KeyboardBridge phase \(next.phase.rawValue, privacy: .public)")
    server.publish(next)
    onChange(next)
  }

  private func observeSystem() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    // Calls, Siri, route changes, and media resets stop the engine; end visibly instead of pretending to listen.
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.end(reason: "Another app or a call interrupted the microphone.") }
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.end(reason: "iOS reset audio services.") }
      },
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: audio, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.end(reason: "The microphone changed. Start a new session.") }
      },
    ]
  }

  private nonisolated static func tap(into sink: KeyboardUtteranceSink) -> AVAudioNodeTapBlock {
    { buffer, time in sink.append(buffer, time: time) }
  }
}
