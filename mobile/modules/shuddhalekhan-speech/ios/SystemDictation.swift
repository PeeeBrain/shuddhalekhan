import ActivityKit
import AVFoundation
import Foundation
import UIKit
import WidgetKit

private enum SystemDictationError: LocalizedError {
  case microphoneDenied, modelUnavailable, activityUnavailable, captureUnavailable, empty

  var errorDescription: String? {
    switch self {
    case .microphoneDenied: "Open Shuddhalekhan to grant microphone access."
    case .modelUnavailable: "Open Shuddhalekhan and install the selected on-device Parakeet model."
    case .activityUnavailable: "Enable Live Activities for Shuddhalekhan or use Dictate in the app."
    case .captureUnavailable: "iOS could not start the microphone here. Open Shuddhalekhan and use Dictate."
    case .empty: "No speech was recognized."
    }
  }
}

@MainActor
final class SystemDictation {
  static let shared = SystemDictation()

  private struct Job {
    let id: String
    let lease: MicrophoneOwnership.Lease
    let file: URL
    let configuration: ParakeetConfiguration
    let preferences: DictationPreferences
    let activityID: String
    var phase: SystemDictationAttributes.Phase = .preparing
    var startedAt: ContinuousClock.Instant?
  }

  private var job: Job?
  private var recorder: AVAudioRecorder?
  private var sessionActive = false
  private var expiry: Task<Void, Never>?
  private var inference: Task<String, Error>?
  private var activityObserver: Task<Void, Never>?
  private var interruptionObservers: [NSObjectProtocol] = []
  private var pendingCopy: String?
  private var finishingTask = UIBackgroundTaskIdentifier.invalid

  private init() {
    let abandoned = Activity<SystemDictationAttributes>.activities.map(\.id)
    Task {
      for id in abandoned {
        await Self.activity(id: id)?.end(ActivityContent(state: .init(phase: .cancelled), staleDate: nil),
          dismissalPolicy: .immediate)
      }
    }
  }

  static func recoverActivities() { _ = shared }

  func takeUncopiedResult() -> String? {
    defer { pendingCopy = nil }
    return pendingCopy
  }

  func toggle() async -> String {
    if let job {
      switch job.phase {
      case .recording:
        // A second simultaneous activation is not an intentional Finish.
        if let since = job.startedAt, since.duration(to: .now) < .milliseconds(500) {
          return "Recording dictation."
        }
        return await finish(id: job.id)
      default: return job.phase.title
      }
    }
    return await start()
  }

  private func start() async -> String {
    guard AVAudioApplication.shared.recordPermission == .granted else {
      return SystemDictationError.microphoneDenied.localizedDescription
    }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      return SystemDictationError.activityUnavailable.localizedDescription
    }
    guard let language = DictationSettings.language,
          let configuration = try? ParakeetConfiguration(language: language) else {
      return SystemDictationError.modelUnavailable.localizedDescription
    }
    guard let lease = try? MicrophoneOwnership.shared.claim(.system) else {
      return MicrophoneError.busy.localizedDescription
    }

    let id = UUID().uuidString
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("system-dictation-\(id).wav")
    let activityID: String
    do {
      activityID = try Activity.request(attributes: SystemDictationAttributes(requestID: id),
        content: ActivityContent(state: .init(phase: .preparing), staleDate: Date().addingTimeInterval(30)), pushType: nil).id
    } catch {
      MicrophoneOwnership.shared.release(lease)
      return SystemDictationError.activityUnavailable.localizedDescription
    }

    pendingCopy = nil
    job = Job(id: id, lease: lease, file: file, configuration: configuration,
      preferences: DictationSettings.preferences, activityID: activityID)
    observe(id: id, activityID: activityID)
    do {
      do { try await ParakeetEngine.shared.prepare(configuration: configuration) }
      catch { throw SystemDictationError.modelUnavailable }
      guard job?.id == id else { return "Dictation cancelled." }
      try Task.checkCancellation()

      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
      try session.setActive(true)
      sessionActive = true
      let recorder = try AVAudioRecorder(url: file, settings: [
        AVFormatIDKey: Int(kAudioFormatLinearPCM), AVSampleRateKey: 16_000,
        AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
      ])
      self.recorder = recorder
      guard recorder.record() else { throw SystemDictationError.captureUnavailable }
      job?.phase = .recording
      job?.startedAt = .now
      expiry = Task { [weak self] in
        do { try await Task.sleep(for: .seconds(120)) } catch { return }
        guard let self, self.job?.id == id else { return }
        self.expiry = nil
        _ = await self.finish(id: id)
      }
      await publish(activityID, phase: .recording)
      guard job?.id == id else { return "Dictation stopped." }
      return "Recording dictation. Run the shortcut again or tap Stop."
    } catch {
      guard job?.id == id else { return "Dictation cancelled." }
      await settle(id: id, phase: .failed)
      if let error = error as? SystemDictationError { return error.localizedDescription }
      return SystemDictationError.captureUnavailable.localizedDescription
    }
  }

  func finish(id: String? = nil) async -> String {
    guard let job, id == nil || id == job.id else { return "There is no matching recording." }
    guard job.phase == .recording else { return job.phase.title }
    let didRecord = recorder?.isRecording == true
    let jobID = job.id
    finishingTask = UIApplication.shared.beginBackgroundTask(withName: "Finish dictation") { [weak self] in
      MainActor.assumeIsolated {
        guard let self, let activityID = self.retire(id: jobID) else { return }
        Task { await self.endActivity(activityID, phase: .failed) }
      }
    }
    releaseAudio()
    guard didRecord else {
      await settle(id: job.id, phase: .failed)
      return "The microphone stopped before dictation could finish."
    }
    self.job?.phase = .transcribing
    // The task owns the file until inference returns, including when a cancelled decoder unwinds later.
    let inference = Task {
      defer { try? FileManager.default.removeItem(at: job.file) }
      let raw = try await ParakeetEngine.shared.transcribe(job.file, configuration: job.configuration)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      try Task.checkCancellation()
      guard !raw.isEmpty else { throw SystemDictationError.empty }
      return await DictationCleanup.format(raw, preferences: job.preferences, language: job.configuration.language)
    }
    self.inference = inference
    await publish(job.activityID, phase: .transcribing)
    do {
      let text = try await inference.value
      guard self.job?.id == job.id, !Task.isCancelled else {
        await settle(id: job.id, phase: .cancelled)
        return "Dictation cancelled."
      }
      guard !text.isEmpty else { throw SystemDictationError.empty }
      // Clipboard writes in the background are not reliably observable. Keep a copyable result in the app.
      let phase: SystemDictationAttributes.Phase
      if UIApplication.shared.applicationState == .active {
        UIPasteboard.general.setItems([["public.utf8-plain-text": text]],
          options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(600)])
        phase = .copied
      } else {
        pendingCopy = text
        phase = .ready
      }
      await settle(id: job.id, phase: phase)
      return phase.title
    } catch {
      guard self.job?.id == job.id else { return "Dictation cancelled." }
      await settle(id: job.id, phase: .failed)
      return (error as? SystemDictationError)?.localizedDescription ?? "Could not transcribe with on-device Parakeet."
    }
  }

  func cancel(id: String? = nil) async -> String {
    guard let job, id == nil || id == job.id else { return "There is no matching recording." }
    await settle(id: job.id, phase: .cancelled)
    return "Dictation cancelled."
  }

  private func observe(id: String, activityID: String) {
    activityObserver = Task { [weak self] in
      guard let updates = Self.activity(id: activityID)?.activityStateUpdates else { return }
      for await state in updates where state == .dismissed || state == .ended {
        await self?.settle(id: id, phase: .cancelled)
        return
      }
    }
    interruptionObservers = [
      AVAudioSession.interruptionNotification, AVAudioSession.mediaServicesWereResetNotification,
      AVAudioSession.routeChangeNotification,
    ].map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
        if name == AVAudioSession.routeChangeNotification {
          let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
          guard reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue ||
            reason == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue else { return }
        } else if note.isAudioInterruptionEnd { return }
        Task { @MainActor in await self?.settle(id: id, phase: .failed) }
      }
    }
  }

  private func releaseAudio() {
    expiry?.cancel()
    expiry = nil
    recorder?.stop()
    recorder = nil
    if sessionActive {
      sessionActive = false
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  private nonisolated static func activity(id: String) -> sending Activity<SystemDictationAttributes>? {
    Activity<SystemDictationAttributes>.activities.first { $0.id == id }
  }

  private func publish(_ activityID: String, phase: SystemDictationAttributes.Phase) async {
    let deadline = Date().addingTimeInterval(phase == .recording ? 125 : 30)
    await Self.activity(id: activityID)?.update(ActivityContent(state: .init(phase: phase), staleDate: deadline))
    if #available(iOS 18.0, *) { ControlCenter.shared.reloadControls(ofKind: "com.shuddhalekhan.mobile.dictate") }
  }

  private func settle(id: String, phase: SystemDictationAttributes.Phase) async {
    guard let activityID = retire(id: id) else { return }
    await endActivity(activityID, phase: phase)
  }

  private func retire(id: String) -> String? {
    guard let job, job.id == id else { return nil }
    self.job = nil
    releaseAudio()
    activityObserver?.cancel()
    activityObserver = nil
    for observer in interruptionObservers { NotificationCenter.default.removeObserver(observer) }
    interruptionObservers.removeAll()
    if let inference { inference.cancel() } else { try? FileManager.default.removeItem(at: job.file) }
    inference = nil
    MicrophoneOwnership.shared.release(job.lease)
    if finishingTask != .invalid {
      UIApplication.shared.endBackgroundTask(finishingTask)
      finishingTask = .invalid
    }
    return job.activityID
  }

  private func endActivity(_ activityID: String, phase: SystemDictationAttributes.Phase) async {
    await Self.activity(id: activityID)?.end(ActivityContent(state: .init(phase: phase), staleDate: nil),
      dismissalPolicy: .after(Date().addingTimeInterval(12)))
    if #available(iOS 18.0, *) { ControlCenter.shared.reloadControls(ofKind: "com.shuddhalekhan.mobile.dictate") }
  }
}

// Called by the app target's intents, with no dependency on the Expo module or mounted React views.
@MainActor
public enum SystemDictationActions {
  public static func dictate() async -> String { await SystemDictation.shared.toggle() }
  public static func finish(requestID: String?) async -> String { await SystemDictation.shared.finish(id: requestID) }
  public static func cancel(requestID: String?) async -> String { await SystemDictation.shared.cancel(id: requestID) }

  public static func startKeyboard() async -> String {
    guard let language = DictationSettings.language else { return "Open Shuddhalekhan and set up the local speech model first." }
    let keyboard = KeyboardSessionHost.shared
    guard !keyboard.ownsAudio else { return "A keyboard session is already running or preparing." }
    // Audio activation and the existing discovery pasteboard require an active app.
    for _ in 0..<20 where UIApplication.shared.applicationState != .active {
      do { try await Task.sleep(for: .milliseconds(100)) } catch { return "Keyboard session cancelled." }
    }
    guard UIApplication.shared.applicationState == .active else {
      return "Open Shuddhalekhan and tap Start keyboard session."
    }
    do {
      try await keyboard.start(minutes: DictationSettings.preferences.sessionMinutes,
        configuration: ParakeetConfiguration(language: language), agentReady: false)
      return keyboard.state.sessionEndsAt != 0 ? "Keyboard session started." : "Keyboard session is still preparing."
    } catch {
      return error.localizedDescription
    }
  }

  public static func stopKeyboard() -> String {
    KeyboardSessionHost.shared.end()
    return "Keyboard session stopped."
  }
}
