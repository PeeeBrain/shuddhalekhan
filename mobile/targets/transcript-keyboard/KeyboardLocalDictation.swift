// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXKeyboard/KeyboardLocalDictation.swift
// and KeyboardParakeet.swift. See Typing/NOTICE.md.

import AVFAudio
import Darwin
import FluidAudio
import Foundation
import Speech
import UIKit

/// Dictate with no keyboard session: the keyboard records itself (`KeyboardWebCapture`, iOS 26) and transcribes with
/// its own Parakeet copy where that fits in its memory, else with Apple's speech recognition (`KeyboardAppleSpeech`),
/// as Hex's keyboard does. Without an App Group it can't read the app's model, so it downloads one into its container
/// once. No Live Activity, no app switch; audio that the capture paused resumes after it (Hex's pattern). Before
/// iOS 26 a keyboard's web view gets no microphone, so the caller only starts it there.
@MainActor
final class KeyboardLocalDictation {
  enum Phase { case idle, starting, recording, transcribing }

  enum Engine {
    case parakeet(ParakeetConfiguration)
    /// Apple's speech recognition in the session's language, or "" for the iPhone's.
    case apple(language: String)

    var language: String {
      switch self {
      case .parakeet(let configuration): configuration.language
      case .apple(let language): language
      }
    }
  }

  private(set) var phase = Phase.idle {
    didSet {
      guard phase != oldValue else { return }
      if phase == .idle, releasesModel {
        // After a memory warning mid-dictation, once its transcription ends (`release` waits for one under way).
        releasesModel = false
        retireCapture()
        Task { await KeyboardParakeet.shared.release() }
      }
      onChange?()
    }
  }
  private var releasesModel = false
  /// Why a recording stopped early: shown with its transcript, once the strip is back, unless something replaces it.
  private var earlyStop: String?
  private var transcribing: URL?
  private var lastAudio: TimeInterval = 0
  private var asked = false
  var onChange: (() -> Void)?
  var onLevel: ((CGFloat) -> Void)?
  var onText: ((String) -> Void)?
  /// `beforeRecording`: the microphone never opened, so the caller can still fall back to the app's session.
  var onFailure: ((String, _ beforeRecording: Bool) -> Void)?

  /// A recording this long stops itself: FluidAudio holds the whole recording in the keyboard's memory.
  static let longestAudio: TimeInterval = 90
  /// After a capture ends, long enough for WebKit to have let its audio session go.
  private static let resumeOtherAudioDelay: TimeInterval = 0.5
  /// A stop that never hears back from the page (its process died) finishes with what it has.
  private static let stopPatience: TimeInterval = 2
  /// A recording that hears nothing this long (WebKit stopped sending audio, or an interruption didn't end) stops with
  /// what it has: Hex's `captureInterruption`, so an interruption that ends in time keeps recording.
  private static let stallPatience: TimeInterval = 15
  /// For the audio server's preflight and the page's load, before the microphone is asked for (and a permission
  /// prompt may be up): a stall hands over to the app.
  private static let askPatience: TimeInterval = 5
  /// Hex's wait for a capture's first audio.
  private static let firstAudioPatience: TimeInterval = 3
  private static let audioSessionQueue = DispatchQueue(label: "com.shuddhalekhan.keyboard.audio-session", qos: .userInitiated)

  private var capture: KeyboardWebCapture?
  private var file: KeyboardPCMFile?
  private var engine: Engine?
  /// Parakeet holds the whole recording in the keyboard's memory; Apple's model runs in Apple's speech service.
  private var budgetsMemory: Bool {
    if case .parakeet? = engine { return true }
    return false
  }
  private var style = DictationStyle.legacy
  private var otherAudioAtStart = false
  /// The dictation that last opened a microphone, in any keyboard instance.
  private static weak var audioOwner: KeyboardLocalDictation?
  private var level: CGFloat = 0
  /// Bumped by every start, stop and cancel, so late events and transcriptions of an earlier dictation do nothing.
  private var generation = 0

  init() {
    _ = Self.abandonedRecordingsRemoved
  }

  /// What a keyboard iOS ended mid-dictation left behind: once per process, before it records anything.
  private static let abandonedRecordingsRemoved: Void = {
    let folder = FileManager.default.temporaryDirectory
    for url in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    where url.lastPathComponent.hasPrefix("keyboard-") && url.pathExtension == "wav" {
      try? FileManager.default.removeItem(at: url)
    }
  }()

  // MARK: Readiness

  /// Whether the keyboard can dictate by itself now: its model downloaded, a memory limit a transcription fits in,
  /// room to record (32 MB, Hex's figure), and no memory warning in the last 5 minutes (Hex: reloading right after one
  /// gets the keyboard killed). Otherwise the app's session takes it, before anything is said.
  static func canStart(_ configuration: ParakeetConfiguration) -> Bool {
    cooledDown && !isDownloading && KeyboardParakeet.isInstalled(configuration) && KeyboardParakeet.fits(headroom: captureHeadroom)
  }

  /// FluidAudio compiles each model as it downloads, so a download waits out a memory warning too.
  static var canDownload: Bool { cooledDown && KeyboardParakeet.canLoad }

  /// iOS warned the keyboard about memory (Hex): nothing loads or downloads for 5 minutes, a download stops, and the
  /// model and an idle web view go. A dictation under way keeps the model for its own transcription.
  static func memoryWarned(_ local: KeyboardLocalDictation?) {
    warnedAt = Date()
    cancelDownload()
    if let local, local.phase != .idle {
      local.releasesModel = true
      return
    }
    local?.retireCapture()
    Task { await KeyboardParakeet.shared.release() }
  }

  private static let captureHeadroom = 32 * KeyboardParakeet.megabyte
  private static var cooledDown: Bool { warnedAt.map { Date().timeIntervalSince($0) >= 300 } ?? true }
  /// Kept across processes: iOS may end the keyboard right after its warning.
  private static var warnedAt: Date? {
    get { UserDefaults.standard.object(forKey: "keyboardMemoryWarnedAt") as? Date }
    set { UserDefaults.standard.set(newValue, forKey: "keyboardMemoryWarnedAt") }
  }
  private static var downloadTask: Task<Void, Never>?
  static var isDownloading: Bool { downloadTask != nil }

  /// Downloads the keyboard's model once; FluidAudio skips files it has. No percent: FluidAudio reports each model
  /// file from 0 and then compiles it. A cancelled download doesn't hear `done`.
  static func download(_ configuration: ParakeetConfiguration, done: @escaping @MainActor @Sendable (Bool) -> Void) {
    guard downloadTask == nil else { return }
    downloadTask = Task {
      let ok = (try? await KeyboardParakeet.shared.download(configuration)) != nil
      let cancelled = Task.isCancelled
      downloadTask = nil
      if !cancelled { done(ok) }
    }
  }

  /// ✕ on the download's notice: FluidAudio keeps what it finished, and the next Dictate goes on from there.
  static func cancelDownload() {
    downloadTask?.cancel()
  }

  // MARK: Dictation

  func start(in host: UIView, engine: Engine, style: DictationStyle) {
    guard phase == .idle else { return }
    generation += 1
    let current = generation
    self.engine = engine
    self.style = style
    level = 0
    phase = .starting
    // The model loads before the microphone opens (seconds the first time: Parakeet compiles for the Neural Engine,
    // Apple's may download), so a keyboard that can't hands over to the app before anything is said.
    Task { [weak self] in
      let failure = await Self.prepare(engine)
      guard let self, self.generation == current, self.phase == .starting else { return }
      if let failure { return self.fail(failure, beforeRecording: true) }
      self.openMicrophone(in: host, generation: current)
    }
  }

  /// Nil once `engine` can take a dictation, else why it can't.
  private static func prepare(_ engine: Engine) async -> String? {
    switch engine {
    case .parakeet(let configuration):
      let loaded = await KeyboardParakeet.shared.prepare(configuration)
      return loaded && cooledDown && KeyboardParakeet.fits(headroom: captureHeadroom)
        ? nil : "Not enough memory to dictate in the keyboard."
    case .apple(let language):
      guard #available(iOS 26.0, *) else { return "Dictating in the keyboard needs iOS 26." }
      do {
        try await KeyboardAppleSpeech.prepare(language)
        return nil
      } catch {
        return (error as? LocalizedError)?.errorDescription ?? "Apple's speech recognition isn't ready. Try again."
      }
    }
  }

  private static func transcribe(_ url: URL, engine: Engine, seconds: Double) async throws -> String {
    switch engine {
    case .parakeet(let configuration):
      return try await KeyboardParakeet.shared.transcribe(url, configuration: configuration, seconds: seconds)
    case .apple(let language):
      guard #available(iOS 26.0, *) else { throw CancellationError() }
      return try await KeyboardAppleSpeech.transcribe(url, language: language)
    }
  }

  private func openMicrophone(in host: UIView, generation current: Int) {
    Self.audioOwner = self
    let capture = self.capture ?? KeyboardWebCapture(host: host)
    capture.attach(to: host)
    self.capture = capture
    capture.onEvent = { [weak self] event in self?.handle(event, generation: current) }
    asked = false
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.askPatience) { [weak self] in
      guard let self, self.generation == current, self.phase == .starting, !self.asked else { return }
      self.capture?.stop(flush: false)
      self.fail("The keyboard's recorder didn't start.", beforeRecording: true)
    }
    // The audio session's calls are round trips to the audio server, so they stay off the main thread (Hex).
    Self.audioSessionQueue.async { [weak self, weak capture] in
      _ = Self.hapticsAllowed
      let otherAudio = AVAudioSession.sharedInstance().isOtherAudioPlaying
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, let capture, self.generation == current, self.phase == .starting else { return }
          self.otherAudioAtStart = self.otherAudioAtStart || otherAudio
          capture.start()
        }
      }
    }
  }

  /// ✓: the page flushes its last buffer, then `.stopped` transcribes. Before the microphone opened there is
  /// nothing to keep.
  func stop() {
    switch phase {
    case .starting: cancel()
    case .recording:
      phase = .transcribing
      capture?.stop()
      let current = generation
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.stopPatience) { [weak self] in
        guard let self, self.generation == current, self.file != nil else { return }
        // The page may still hold the microphone: its web view goes with it.
        self.retireCapture()
        self.finish()
      }
    case .idle, .transcribing: break
    }
  }

  /// Leaves at once: what was recorded is deleted, and a transcription under way is ignored.
  func cancel() {
    // Idle too, as the keyboard hides: a web view left attached keeps a dismissed keyboard's views alive (Hex).
    guard phase != .idle else { return retireCapture() }
    generation += 1
    earlyStop = nil
    capture?.stop(flush: false)
    // Its page may never finish letting go (a close that stalls in an interruption): the next start gets a new one.
    retireCapture()
    discardFile()
    // A transcription still queued finds its audio gone and doesn't run.
    if let transcribing { try? FileManager.default.removeItem(at: transcribing) }
    releaseAudioSession()
    phase = .idle
  }

  /// Never reused: the next dictation makes a new web view rather than sit beside this one. Torn down after the
  /// current delegate callback returns (Hex).
  private func retireCapture() {
    let dead = capture
    capture = nil
    dead?.onEvent = nil
    DispatchQueue.main.async { dead?.tearDown() }
  }

  private func handle(_ event: KeyboardWebCapture.Event, generation current: Int) {
    if case .processTerminated = event {
      retireCapture()
      guard generation == current else { return }
      if phase == .starting { return fail("The microphone stopped. Try again.", beforeRecording: true) }
      if phase == .recording { earlyStop = "Stopped early: the microphone was interrupted." }
      if file != nil { finish() }
      return
    }
    guard generation == current else { return }
    switch event {
    case .asked:
      asked = true
    case .started(let rate):
      guard phase == .starting, file == nil else { return }
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("keyboard-\(UUID().uuidString).wav")
      do {
        file = try KeyboardPCMFile(url: url, sampleRate: rate)
      } catch {
        capture?.stop(flush: false)
        return fail("Couldn't record here. Try again.", beforeRecording: true)
      }
      // Recording begins with the first audio (Hex): a microphone that sends none (a call took it) hands over to the
      // app. After the permission prompt, which comes before `.started`.
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.firstAudioPatience) { [weak self] in
        guard let self, self.generation == current, self.phase == .starting else { return }
        self.capture?.stop(flush: false)
        self.fail("The microphone sent nothing.", beforeRecording: true)
      }
    case .samples(let data, let peak):
      guard let file else { return }
      lastAudio = ProcessInfo.processInfo.systemUptime
      do {
        try file.append(data)
      } catch {
        // Out of storage: what was written is kept and transcribed. Before any, the app takes the dictation.
        if phase == .starting {
          capture?.stop(flush: false)
          return fail("Couldn't record here. Try again.", beforeRecording: true)
        }
        guard phase == .recording else { return }
        earlyStop = "Stopped early: the phone is out of storage."
        stop()
        return
      }
      // The app session's meter mapping: -50 dB to 0 dB, smoothed.
      let db = 20 * log10(max(Double(peak), 1e-6))
      level = level * 0.35 + CGFloat(min(1, max(0, (db + 50) / 50))) * 0.65
      if phase == .starting {
        // Room for a few seconds, so a recording that starts isn't stopped early before it holds a word.
        guard !budgetsMemory || KeyboardParakeet.canTranscribe(seconds: 5) else {
          capture?.stop(flush: false)
          return fail("Not enough memory to dictate in the keyboard.", beforeRecording: true)
        }
        phase = .recording
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.longestAudio) { [weak self] in
          guard let self, self.generation == current, self.phase == .recording else { return }
          self.stop()
        }
        watchForStall(current)
      }
      guard phase == .recording else { return }
      onLevel?(level)
      // Stops while its transcription still fits, rather than be discarded at the end for want of memory.
      if budgetsMemory, !KeyboardParakeet.canTranscribe(seconds: file.seconds + 1) {
        earlyStop = "Stopped early: the keyboard is low on memory."
        stop()
      }
    case .stopped:
      if file != nil, phase == .transcribing { finish() }
    case .failed:
      guard phase == .starting else { return }
      fail("Couldn't use the microphone here.", beforeRecording: true)
    case .interrupted:
      guard phase == .recording else { return }
      earlyStop = "Stopped early: the microphone was interrupted."
      stop()
    case .processTerminated:
      break
    }
  }

  private func watchForStall(_ current: Int) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
      guard let self, self.generation == current, self.phase == .recording else { return }
      guard ProcessInfo.processInfo.systemUptime - self.lastAudio < Self.stallPatience else {
        self.earlyStop = "Stopped early: the microphone was interrupted."
        return self.stop()
      }
      self.watchForStall(current)
    }
  }

  private func finish() {
    guard let file, let engine else { return }
    self.file = nil
    generation += 1
    let current = generation
    file.close()
    releaseAudioSession()
    let seconds = file.seconds
    // Under a third of a second can't hold a word: end quietly, as the app session does with silence.
    guard seconds >= 0.3 else {
      try? FileManager.default.removeItem(at: file.url)
      phase = .idle
      if let notice = earlyStop {
        earlyStop = nil
        onFailure?(notice, false)
      }
      return
    }
    phase = .transcribing
    transcribing = file.url
    let style = style
    Task { [weak self] in
      let result: Result<String, Error>
      do {
        result = .success(try await Self.transcribe(file.url, engine: engine, seconds: seconds))
      } catch {
        result = .failure(error)
      }
      try? FileManager.default.removeItem(at: file.url)
      guard let self, self.generation == current else { return }
      switch result {
      case .success(let heard):
        // Inserted before the keyboard leaves its dictation state, as the session path does.
        let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        if let notice = self.earlyStop {
          self.earlyStop = nil
          self.onFailure?(notice, false)
        }
        if !text.isEmpty {
          let styled = DictationFormatter.style(text, as: style, language: engine.language)
          self.onText?(styled.isEmpty ? text : styled)
        }
        self.phase = .idle
      case .failure(let error):
        self.fail((error as? LocalizedError)?.errorDescription ?? "Dictation failed. Try again.", beforeRecording: false)
      }
    }
  }

  private func fail(_ message: String, beforeRecording: Bool) {
    generation += 1
    earlyStop = nil
    retireCapture()
    discardFile()
    releaseAudioSession()
    phase = .idle
    onFailure?(message, beforeRecording)
  }

  private func discardFile() {
    guard let file else { return }
    self.file = nil
    file.close()
    try? FileManager.default.removeItem(at: file.url)
  }

  // MARK: Audio session

  /// WebKit records in this process's audio session, and iOS mutes a recording session's haptics by default: key
  /// haptics stay on. Set once per process, on the session's queue.
  nonisolated private static let hapticsAllowed: Void = {
    try? AVAudioSession.sharedInstance().setAllowHapticsAndSystemSoundsDuringRecording(true)
  }()

  /// Asks the video or music the capture interrupted to resume, once WebKit has let its session go.
  private func releaseAudioSession() {
    guard otherAudioAtStart else { return }
    otherAudioAtStart = false
    // Holds nothing of this keyboard, so the video or music resumes even if iOS closes it meanwhile.
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.resumeOtherAudioDelay) {
      // A capture under way (this keyboard's, or a newer one's), or a stop still flushing its last buffer, asks again
      // at its own end.
      if let owner = Self.audioOwner, owner.phase == .starting || owner.phase == .recording || owner.file != nil {
        owner.otherAudioAtStart = true
        return
      }
      Self.audioSessionQueue.async {
        let session = AVAudioSession.sharedInstance()
        guard !session.isOtherAudioPlaying else { return }
        try? session.setCategory(.playback, mode: .default, options: [])
        try? session.setActive(true)
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
      }
    }
  }
}

/// The keyboard's own Parakeet: the same models and settings as the app's `ParakeetEngine`, in the keyboard's
/// container, loaded only within the keyboard's memory limit (Hex's `KeyboardParakeetBudget`, measured on an
/// iPhone 17 Pro).
actor KeyboardParakeet {
  static let shared = KeyboardParakeet()
  static let megabyte = 1_048_576
  /// The keyboard's footprint while recording (91 MB), a transcription's rise (16 MB) and a margin (24 MB).
  private static let requiredLimit = 131 * megabyte
  private static let loadHeadroom = 58 * megabyte
  private static let transcribeHeadroom = 24 * megabyte
  /// What a second of audio costs while FluidAudio holds the recording.
  private static let audioCostPerSecond = megabyte / 2

  private enum Failure: LocalizedError {
    case shortOfMemory
    var errorDescription: String? { "Not enough memory to transcribe in the keyboard. Try a shorter dictation." }
  }

  private var manager: AsrManager?
  private var model: ParakeetModel?
  private var loading: Task<AsrManager, Error>?
  private var isTranscribing = false
  /// The last transcription: a cancelled dictation's keeps running, and the next waits for it.
  private var last: Task<String, Error>?
  private var releasesAfterTranscription = false
  private var downloading = false

  private static func version(_ configuration: ParakeetConfiguration) -> AsrModelVersion {
    configuration.model == .english ? .v2 : .v3
  }

  /// Room to transcribe `seconds` of audio with the model loaded.
  static func canTranscribe(seconds: Double) -> Bool {
    fits(headroom: transcribeHeadroom + Int(seconds * Double(audioCostPerSecond)))
  }

  /// FluidAudio compiles each model as it downloads, so a download needs the room a load does.
  static var canLoad: Bool { fits(headroom: loadHeadroom) }

  /// Within the keyboard's memory limit. On a device 0 available means over it; the simulator sets none.
  static func fits(headroom: Int) -> Bool {
    let memory = memory()
    #if targetEnvironment(simulator)
    if memory.available == 0 { return true }
    #endif
    return memory.footprint + memory.available >= requiredLimit && memory.available >= headroom
  }

  /// A keyboard killed mid-download can leave a model folder that looks whole, so only a finished download counts.
  static func isInstalled(_ configuration: ParakeetConfiguration) -> Bool {
    let version = version(configuration)
    return UserDefaults.standard.bool(forKey: installedKey(version))
      && AsrModels.modelsExist(at: AsrModels.defaultCacheDirectory(for: version), version: version, encoderPrecision: .int8)
  }

  private static func installedKey(_ version: AsrModelVersion) -> String {
    "keyboardParakeetInstalled-\(version == .v2 ? "v2" : "v3")"
  }

  func download(_ configuration: ParakeetConfiguration) async throws {
    let version = Self.version(configuration)
    _ = await last?.result
    try Task.checkCancellation()
    downloading = true
    ModelHub.offlineMode = false
    // The other language's model, if loaded, leaves its memory to this one's compile.
    release()
    defer { downloading = false }
    _ = try await AsrModels.download(to: AsrModels.defaultCacheDirectory(for: version), force: false, version: version,
      encoderPrecision: .int8)
    // FluidAudio skips the download when the files exist, which a keyboard ended mid-download can leave incomplete.
    // Loaded online, a model that doesn't load is deleted and fetched again; it stays loaded for the first Dictate.
    try Task.checkCancellation()
    _ = try await load(configuration)
    // Loaded, the files are whole: a ✕ during the load keeps the install, but not the memory.
    if Task.isCancelled { release() }
    UserDefaults.standard.set(true, forKey: Self.installedKey(version))
    // One model at a time: a language that switched v2 ↔ v3 doesn't leave the other's hundreds of MB behind.
    let other: AsrModelVersion = version == .v2 ? .v3 : .v2
    UserDefaults.standard.removeObject(forKey: Self.installedKey(other))
    try? FileManager.default.removeItem(at: AsrModels.defaultCacheDirectory(for: other))
  }

  /// Loads the model when it fits: false when it doesn't, or the load failed.
  func prepare(_ configuration: ParakeetConfiguration) async -> Bool {
    (try? await load(configuration)) != nil
  }

  func transcribe(_ url: URL, configuration: ParakeetConfiguration, seconds: Double) async throws -> String {
    let previous = last
    let task = Task {
      _ = await previous?.result
      guard FileManager.default.fileExists(atPath: url.path) else { throw CancellationError() }
      return try await run(url, configuration: configuration, seconds: seconds)
    }
    last = task
    return try await task.value
  }

  private func run(_ url: URL, configuration: ParakeetConfiguration, seconds: Double) async throws -> String {
    let manager = try await load(configuration)
    guard Self.canTranscribe(seconds: seconds) else { throw Failure.shortOfMemory }
    isTranscribing = true
    defer {
      isTranscribing = false
      if releasesAfterTranscription { release() }
    }
    // Converted in memory, as `canTranscribe` budgets (Hex): FluidAudio's URL overload would write a second copy of a
    // recording over 30 s to disk, which a full disk (one reason a recording stops early) can't hold.
    let samples = try AudioConverter().resampleAudioFile(url)
    var state = try TdtDecoderState()
    return try await manager.transcribe(samples, decoderState: &state,
      language: configuration.model == .multilingual ? Language(rawValue: configuration.language) : nil).text
  }

  /// Now, or once the transcription under way ends.
  func release() {
    if isTranscribing {
      releasesAfterTranscription = true
      return
    }
    releasesAfterTranscription = false
    loading?.cancel()
    loading = nil
    let released = manager
    manager = nil
    model = nil
    if let released { Task { await released.cleanup() } }
  }

  private func load(_ configuration: ParakeetConfiguration) async throws -> AsrManager {
    if model == configuration.model, let manager { return manager }
    if let loading, model == configuration.model {
      let loaded = try await loading.value
      guard self.loading == loading || manager === loaded else { throw CancellationError() }
      return loaded
    }
    release()
    guard Self.canLoad else { throw Failure.shortOfMemory }
    // FluidAudio answers a failed load (in a keyboard, usually memory) by deleting the model and downloading it again.
    // Offline, the load just fails and the app's session takes the dictation.
    if !downloading { ModelHub.offlineMode = true }
    model = configuration.model
    let version = Self.version(configuration)
    // v3's mel prepend and parallel chunks can switch languages at chunk boundaries; v2 keeps FluidAudio's defaults.
    // One chunk at a time (Hex): parallel chunks would outgrow the memory budget measured for one.
    let config = configuration.model == .english
      ? ASRConfig(parallelChunkConcurrency: 1) : ASRConfig(parallelChunkConcurrency: 1, melChunkContext: false)
    let task = Task {
      let models = try await AsrModels.load(from: AsrModels.defaultCacheDirectory(for: version), version: version,
        encoderPrecision: .int8)
      let manager = AsrManager(config: config)
      try await manager.loadModels(models)
      return manager
    }
    loading = task
    do {
      let loaded = try await task.value
      // A release or another language while it loaded: this load is no longer wanted.
      guard loading == task else {
        await loaded.cleanup()
        throw CancellationError()
      }
      loading = nil
      manager = loaded
      return loaded
    } catch {
      if loading == task {
        loading = nil
        model = nil
      }
      throw error
    }
  }

  static func memory() -> (footprint: Int, available: Int) {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return (result == KERN_SUCCESS ? Int(info.phys_footprint) : 0, os_proc_available_memory())
  }
}

/// Apple's speech recognition, Hex's keyboard engine where Parakeet doesn't fit (`KeyboardSpeech`): its model runs in
/// Apple's speech service, so it costs the keyboard a few MB. The language's model installs once, on the first Dictate.
@available(iOS 26.0, *)
enum KeyboardAppleSpeech {
  private enum Failure: LocalizedError {
    case unsupported
    var errorDescription: String? { "Apple's speech recognition can't dictate this language on this iPhone." }
  }

  static func prepare(_ language: String) async throws {
    let speech = try await module(language)
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [speech.module]) {
      try await request.downloadAndInstall()
    }
  }

  static func transcribe(_ url: URL, language: String) async throws -> String {
    let speech = try await module(language)
    let analyzer = SpeechAnalyzer(modules: [speech.module])
    try await analyzer.start(inputAudioFile: try AVAudioFile(forReading: url), finishAfterFile: true)
    return try await speech.finalText()
  }

  /// The session's language in this iPhone's region (en on an Indian iPhone is en-IN), else the iPhone's language.
  /// `SpeechTranscriber` where it can, else `DictationTranscriber`, which has more languages (Hex).
  private static func module(_ language: String) async throws -> Module {
    let current = Locale.current
    let wanted = language.isEmpty || current.language.languageCode?.identifier == language ? current : Locale(identifier: language)
    if SpeechTranscriber.isAvailable, let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) {
      return .speech(SpeechTranscriber(locale: locale, preset: .transcription))
    }
    if let locale = await DictationTranscriber.supportedLocale(equivalentTo: wanted) {
      return .dictation(DictationTranscriber(locale: locale, preset: .longDictation))
    }
    throw Failure.unsupported
  }

  private enum Module {
    case speech(SpeechTranscriber)
    case dictation(DictationTranscriber)

    var module: any SpeechModule {
      switch self {
      case .speech(let transcriber): transcriber
      case .dictation(let transcriber): transcriber
      }
    }

    /// The final results back to back, once the analyzer has finished the file.
    func finalText() async throws -> String {
      var text = ""
      switch self {
      case .speech(let transcriber):
        for try await result in transcriber.results where result.isFinal { text += String(result.text.characters) }
      case .dictation(let transcriber):
        for try await result in transcriber.results where result.isFinal { text += String(result.text.characters) }
      }
      return text
    }
  }
}
