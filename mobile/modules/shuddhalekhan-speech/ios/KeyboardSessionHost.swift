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
  private let onChange: @MainActor (KeyboardSession.State) -> Void
  private let audio = AVAudioEngine()
  private let sink = UtteranceSink()
  private(set) var state = KeyboardSession.State.ended
  private var starting = false
  private var endWhenIdle = false
  private var endTimer: Timer?
  private var utteranceTimer: Timer?
  private var utteranceURL: URL?
  private var observers: [NSObjectProtocol] = []
  private let server = KeyboardSessionServer()
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "KeyboardBridge")

  init(speech: ParakeetEngine, onChange: @escaping @MainActor (KeyboardSession.State) -> Void) {
    self.speech = speech
    self.onChange = onChange
    server.onCommand = { [weak self] command in self?.handleCommand(command) }
    server.onFailure = { [weak self] in self?.end(reason: "The keyboard connection stopped. Start a new session.") }
  }

  func start(minutes: Int) async throws {
    guard (1...30).contains(minutes) else { throw KeyboardSessionError.invalidDuration }
    guard !starting, !state.isLive(now: KeyboardSession.nowMs()) else { return }
    starting = true
    defer { starting = false }

    guard await AVAudioApplication.requestRecordPermission() else { throw KeyboardSessionError.microphoneDenied }
    // Load Parakeet now so the first utterance is not a cold load while the app is in the background.
    try await speech.prepare()

    guard UIApplication.shared.applicationState == .active else { throw KeyboardSessionError.bridgeUnavailable }
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .default)
    try session.setActive(true)
    let input = audio.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      throw KeyboardSessionError.noInput
    }
    input.installTap(onBus: 0, bufferSize: 4_096, format: format, block: Self.tap(into: sink))
    do {
      try audio.start()
    } catch {
      input.removeTap(onBus: 0)
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      throw error
    }

    let endsAt = Date().addingTimeInterval(TimeInterval(minutes * 60))
    do {
      let bridge = try await server.start(expiresAt: KeyboardSession.nowMs(endsAt))
      guard UIApplication.shared.applicationState == .active,
            let board = UIPasteboard(name: UIPasteboard.Name(KeyboardSession.discoveryPasteboard), create: true),
            let payload = KeyboardSession.encode(bridge) else { throw KeyboardSessionError.bridgeUnavailable }
      // This is the only app-side pasteboard access, before the app backgrounds.
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
      sessionEndsAt: KeyboardSession.nowMs(endsAt), requestId: nil, phase: .idle, text: nil, error: nil))
  }

  /// Ends the session now. An utterance in flight is discarded and the keyboard sees the session end.
  func end(reason: String? = nil, completed: KeyboardSession.State? = nil) {
    guard state.sessionEndsAt != 0 else { return }
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
      sessionEndsAt: 0, requestId: completed?.requestId, phase: completed?.phase ?? .idle,
      text: completed?.text, error: reason ?? completed?.error))
    server.stop(final: state)
  }

  private func expire() {
    // Let a started utterance finish; the utterance cap keeps this bounded.
    if state.isBusy { endWhenIdle = true } else { end() }
  }

  private func handleCommand(_ command: KeyboardSession.Command) {
    guard let next = KeyboardSession.transition(state, on: command, now: KeyboardSession.nowMs()) else { return }
    switch next.phase {
    case .recording: beginUtterance(next)
    case .transcribing: finishUtterance(next)
    case .cancelled:
      discardUtterance()
      settle(next)
    default: break
    }
  }

  private func beginUtterance(_ next: KeyboardSession.State) {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("keyboard-\(UUID().uuidString).caf")
    do {
      try sink.begin(url, format: audio.inputNode.outputFormat(forBus: 0))
    } catch {
      settle(next.with(.failed, requestId: next.requestId, error: "Could not start recording."))
      return
    }
    utteranceURL = url
    utteranceTimer = Timer.scheduledTimer(withTimeInterval: Self.maxUtteranceSeconds, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.state.phase == .recording else { return }
        self.finishUtterance(self.state.with(.transcribing, requestId: self.state.requestId))
      }
    }
    publish(next)
  }

  private func finishUtterance(_ next: KeyboardSession.State) {
    utteranceTimer?.invalidate()
    utteranceTimer = nil
    let wrote = sink.end()
    guard let url = utteranceURL, let id = next.requestId, wrote else {
      discardUtterance()
      settle(next.with(.failed, requestId: next.requestId, error: "The recording could not be saved."))
      return
    }
    utteranceURL = nil
    publish(next)
    Task { [speech] in
      let result: Result<String, Error>
      do { result = .success(try await speech.transcribe(url)) } catch { result = .failure(error) }
      try? FileManager.default.removeItem(at: url)
      self.complete(id, result)
    }
  }

  private func complete(_ id: String, _ result: Result<String, Error>) {
    // A cancel, a newer request, or a session end already moved on; drop the stale result.
    guard state.requestId == id, state.phase == .transcribing else { return }
    switch result {
    case .success(let raw):
      let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty {
        settle(state.with(.failed, requestId: id, error: "No speech was recognized."))
      } else if text.utf8.count > KeyboardSession.maxTextBytes {
        settle(state.with(.failed, requestId: id, error: "The transcript is too large."))
      } else {
        settle(state.with(.done, requestId: id, text: text))
      }
    case .failure:
      settle(state.with(.failed, requestId: id, error: "Parakeet could not transcribe this recording."))
    }
  }

  /// Publishes a terminal request state, then honours a session expiry that arrived mid-utterance.
  private func settle(_ next: KeyboardSession.State) {
    // Keep the final result readable after releasing the microphone at session expiry.
    if endWhenIdle { end(completed: next) } else { publish(next) }
  }

  private func discardUtterance() {
    utteranceTimer?.invalidate()
    utteranceTimer = nil
    _ = sink.end()
    if let url = utteranceURL { try? FileManager.default.removeItem(at: url) }
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

  private nonisolated static func tap(into sink: UtteranceSink) -> AVAudioNodeTapBlock {
    { buffer, _ in sink.append(buffer) }
  }
}

/// Written from the audio tap thread, controlled from the main actor.
private final class UtteranceSink: @unchecked Sendable {
  private let lock = NSLock()
  private var file: AVAudioFile?
  private var failed = false

  func begin(_ url: URL, format: AVAudioFormat) throws {
    let file = try AVAudioFile(
      forWriting: url, settings: format.settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    lock.withLock {
      self.file = file
      failed = false
    }
  }

  func append(_ buffer: AVAudioPCMBuffer) {
    lock.withLock {
      guard let file else { return }
      do { try file.write(from: buffer) } catch {
        failed = true
        self.file = nil
      }
    }
  }

  /// Closes the file (by releasing it) and reports whether every buffer was written.
  func end() -> Bool {
    lock.withLock {
      let ok = file != nil && !failed
      file = nil
      return ok
    }
  }
}
