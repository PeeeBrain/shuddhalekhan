import AVFoundation
import OSLog
import UIKit

/// The containing app owns one short-lived output, shared by capture and Settings.
@MainActor
final class RecordingCuePlayer: NSObject, AVAudioPlayerDelegate {
  private lazy var tones = Dictionary(uniqueKeysWithValues: RecordingCue.allCases.map { ($0, $0.wav) })
  private var output: AVAudioPlayer?
  private var completion: CheckedContinuation<Bool, Never>?
  private var finish: Task<Void, Never>?
  private var inputDrain: Duration?
  private var observers: [NSObjectProtocol] = []
  private var restoreSession: (() -> Void)?
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "RecordingCues")

  var enabled: Bool {
    get { RecordingSoundPreference.enabled }
    set {
      RecordingSoundPreference.enabled = newValue
      if !newValue { stop() }
    }
  }

  /// Capture owns the active session. Standalone previews/errors use an output-only session.
  func play(_ cue: RecordingCue, standalone: Bool = false, foregroundOnly: Bool = false) async -> Bool {
    guard enabled, !Task.isCancelled, !standalone || UIApplication.shared.applicationState == .active,
          let data = tones[cue] else { return true }
    stop()
    let session = AVAudioSession.sharedInstance()
    do {
      let player = try AVAudioPlayer(data: data)
      if standalone {
        let (category, mode, options) = (session.category, session.mode, session.categoryOptions)
        try session.setCategory(.ambient, mode: .default)
        restoreSession = {
          try? session.setActive(false, options: .notifyOthersOnDeactivation)
          try? session.setCategory(category, mode: mode, options: options)
        }
        try session.setActive(true)
      }
      player.delegate = self
      guard player.play() else { stop(); return true }
      output = player
      log.notice("Recording cue \(cue.rawValue, privacy: .public)")
      if cue == .start && !standalone {
        let latency = session.outputLatency + session.inputLatency + 2 * session.ioBufferDuration
        inputDrain = .seconds(min(latency, 0.5) + 0.025)
      }
      observeInterruption(foregroundOnly: foregroundOnly)
      return await withCheckedContinuation { continuation in
        completion = continuation
        // Some route failures stop the player without delivering the delegate callback.
        finish = Task {
          do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
          player.stop()
          playbackEnded(ObjectIdentifier(player))
        }
      }
    } catch {
      stop()
      return true
    }
  }

  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully _: Bool) {
    let id = ObjectIdentifier(player)
    Task { @MainActor [weak self] in self?.playbackEnded(id) }
  }

  private func playbackEnded(_ id: ObjectIdentifier) {
    guard let output, ObjectIdentifier(output) == id else { return }
    finish?.cancel()
    guard let inputDrain else { stop(); return }
    // Render completion can precede the last samples clearing the physical route.
    finish = Task {
      do { try await Task.sleep(for: inputDrain) } catch { return }
      stop()
    }
  }

  private func observeInterruption(foregroundOnly: Bool) {
    let center = NotificationCenter.default
    var names = [AVAudioSession.interruptionNotification, AVAudioSession.mediaServicesWereResetNotification]
    if foregroundOnly { names.append(UIApplication.willResignActiveNotification) }
    observers = names.map { name in
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.stop(interrupted: true) }
      }
    }
  }

  func stop(interrupted: Bool = false) {
    output?.stop()
    output = nil
    inputDrain = nil
    finish?.cancel()
    finish = nil
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
    restoreSession?()
    restoreSession = nil
    completion?.resume(returning: !interrupted)
    completion = nil
  }
}
