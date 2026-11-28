import Network
import OSLog
import UIKit

/// The typing keyboard in Typing/ (adapted from Hex, see Typing/NOTICE.md) on Shuddhalekhan's keyboard session. The
/// strip's Dictation key (trailing) and Agent key (leading) ask the app's active keyboard session to record, then
/// insert that request's transcript at the cursor (Dictation) or leave it to the app, which hands it to Agent Mode.
/// See KeyboardSessionProtocol.swift. With no session, Dictation records and transcribes in the keyboard itself
/// (`KeyboardLocalDictation`, iOS 26) once it has its own model; otherwise a voice key opens the app.
final class KeyboardViewController: UIInputViewController {
  private static let ackTimeout: TimeInterval = 3
  private static let connecting = "Connecting to Shuddhalekhan…"
  private static let noSession = "Open Shuddhalekhan and tap Start keyboard session."
  private static let noticeDuration: TimeInterval = 8
  /// iOS shows an empty panel until a keyboard's first frame, and goes back to the previous keyboard when one is slow
  /// to draw (Hex's TestFlight build 56), so the text checker and lexicon wait this long after it appears.
  private static let afterFirstFrame: TimeInterval = 0.3
  /// A voice key tapped with no session opens the app, which starts one (`shuddhalekhan://keyboard-session`).
  /// The first live session the keyboard finds within `launchWindow` starts that recording, so coming back
  /// with ◀ dictates without a second tap. Static: iOS may build a new controller for the return.
  /// The field rides along: coming back to another one doesn't start Dictation there (Agent Mode inserts nothing). Fields UIKit can't name (nil)
  /// can't be told apart, as before.
  private static var awaitingSession: (mode: KeyboardSession.Mode, at: Date, document: UUID?)?
  /// A discovery record whose session is gone (the app ended it in the background, where it can't clear the record):
  /// skipped, so Dictate reaches the keyboard's own recording or the app. Known by the session's last state, or by a
  /// refused connection (no listener); a slow or full listener is retried. Opening the app tries it again.
  private static var deadToken: String?
  private static let launchWindow: TimeInterval = 60
  private static let sessionLink = URL(string: "shuddhalekhan://keyboard-session")!
  /// The last session's Parakeet language and style, for dictating without one.
  private static let languageKey = "localDictationLanguage"
  private static let styleKey = "localDictationStyle"

  private let model = KeyboardViewModel()
  private var keyboard: FullKeyboardView?
  private var heightConstraint: NSLayoutConstraint?
  private var didRequestLexicon = false
  private var noticeWork: DispatchWorkItem?

  private var session: KeyboardSession.State?
  private var pendingId: String?
  private var pendingMode = KeyboardSession.Mode.dictate
  private var pendingDocument: UUID?
  private var insertedIds = Set<String>()
  private var channel: KeyboardSessionChannel?
  private var bridge: KeyboardSession.Bridge?
  private var receivedState = false
  /// Made on the first Dictate the keyboard records itself.
  private var local: KeyboardLocalDictation?
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "KeyboardBridge")

  /// UIKit's own input view, swapped for one that adopts `UIInputViewAudioFeedback` so the keys can click.
  override func loadView() {
    super.loadView()
    let system = inputView
    let input = ClickingInputView(frame: system?.frame ?? .zero, inputViewStyle: system?.inputViewStyle ?? .keyboard)
    input.allowsSelfSizing = system?.allowsSelfSizing ?? false
    input.autoresizingMask = system?.autoresizingMask ?? []
    input.translatesAutoresizingMaskIntoConstraints = system?.translatesAutoresizingMaskIntoConstraints ?? true
    inputView = input
    if viewIfLoaded !== input { view = input }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    let keyboard = FullKeyboardView(model: model, target: DocumentProxyTextTarget { [weak self] in self?.textDocumentProxy })
    keyboard.hostController = self
    keyboard.allowsHaptics = { [weak self] in self?.hasFullAccess ?? false }
    keyboard.onPreferredHeightChange = { [weak self] in
      self?.view.setNeedsLayout()
      self?.view.layoutIfNeeded()
    }
    keyboard.onTextEdit = { [weak self] in
      if self?.model.notice != Self.downloadNotice { self?.clearNotice() }
    }
    keyboard.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(keyboard)
    NSLayoutConstraint.activate([
      keyboard.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      keyboard.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      keyboard.topAnchor.constraint(equalTo: view.topAnchor),
      keyboard.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    self.keyboard = keyboard
    applyHeight(keyboard.preferredHeight)

    model.onStart = { [weak self] in self?.start($0) }
    model.onStop = { [weak self] in self?.stop() }
    model.onCancel = { [weak self] in self?.cancel() }
    model.onStyleSelected = { [weak self] in self?.setStyle($0) }
    model.onDismissNotice = { [weak self] in
      if self?.model.notice == Self.downloadNotice { KeyboardLocalDictation.cancelDownload() }
      self?.clearNotice()
    }
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    log.notice("SpeechPerf keyboard stage=appear")
    model.hasFullAccess = hasFullAccess
    model.needsGlobeKey = needsInputModeSwitchKey
    keyboard?.prepareForField()
    refresh()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    // iOS holds back touches near the screen's side edges while it waits for a system gesture; the edge keys
    // would lag about 80 ms behind the rest (measured upstream in Hex).
    view.window?.gestureRecognizers?.forEach { $0.delaysTouchesBegan = false }
    keyboard?.keyboardDidAppear()
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.afterFirstFrame) { [weak self] in
      guard let self, self.view.window != nil else { return }
      self.keyboard?.warmUpTextCheckerAsync()
      guard !self.didRequestLexicon else { return }
      self.didRequestLexicon = true
      // UIKit calls back on its own queue, so the callback is nonisolated and hops to the main actor itself.
      self.requestSupplementaryLexicon { @Sendable [weak self] lexicon in
        Task { @MainActor in self?.keyboard?.loadLexicon(lexicon) }
      }
    }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    local?.cancel()
    // Closing the authenticated connection cancels its utterance on the app side.
    if let pendingId { send(.cancel, id: pendingId) }
    pendingId = nil
    keyboard?.engine.commitHangulComposition()
    keyboard?.hideUndo()
    disconnect()
    clearNotice()
    render()
  }

  override func viewWillLayoutSubviews() {
    super.viewWillLayoutSubviews()
    if let keyboard { applyHeight(keyboard.preferredHeight) }
  }

  /// Below required so it never fights the system's own keyboard height constraint while appearing; never
  /// animated, since iOS sizes the panel from it while it swaps keyboards.
  private func applyHeight(_ height: CGFloat) {
    guard let heightConstraint else {
      let constraint = view.heightAnchor.constraint(equalToConstant: height)
      constraint.priority = UILayoutPriority(999)
      constraint.isActive = true
      heightConstraint = constraint
      preferredContentSize.height = height
      return
    }
    guard heightConstraint.constant != height else { return }
    UIView.performWithoutAnimation {
      heightConstraint.constant = height
      preferredContentSize.height = height
    }
  }

  override func textDidChange(_ textInput: UITextInput?) {
    super.textDidChange(textInput)
    keyboard?.textDidChange()
  }

  override func selectionDidChange(_ textInput: UITextInput?) {
    super.selectionDidChange(textInput)
    keyboard?.hideUndoIfMoved()
    keyboard?.engine.commitHangulIfHostMoved()
  }

  override func didReceiveMemoryWarning() {
    super.didReceiveMemoryWarning()
    keyboard?.handleMemoryWarning()
    if model.notice == Self.downloadNotice { show("Paused the download: the keyboard is low on memory.") }
    KeyboardLocalDictation.memoryWarned(local)
  }

  // MARK: Session

  private func disconnect() {
    let previous = channel
    channel = nil
    bridge = nil
    session = nil
    previous?.close()
  }

  /// Finds the app's keyboard session and connects. Quiet when there is none: the strip stays the words', and a
  /// voice key says what to do when tapped.
  private func refresh() {
    guard hasFullAccess else { return disconnect() }
    if channel != nil { return }
    guard let data = UIPasteboard(name: UIPasteboard.Name(KeyboardSession.discoveryPasteboard), create: false)?
      .data(forPasteboardType: KeyboardSession.payloadType),
      let bridge = KeyboardSession.decodeBridge(data, now: KeyboardSession.nowMs()), bridge.token != Self.deadToken,
      let port = NWEndpoint.Port(rawValue: bridge.port) else {
      session = nil
      return
    }
    self.bridge = bridge
    receivedState = false
    let link = KeyboardSessionChannel(NWConnection(host: "127.0.0.1", port: port, using: .tcp),
      maxBytes: KeyboardSession.maxTextBytes * 7)
    channel = link
    link.onOpen = { [weak self, weak link] in
      guard let self, let link, self.channel === link else { return }
      self.log.notice("SpeechPerf keyboard stage=connected")
      link.send(KeyboardSession.Request(token: bridge.token, command: nil))
    }
    link.onMessage = { [weak self, weak link] data in
      guard let self, let link, self.channel === link else { return }
      guard let state = KeyboardSession.decodeState(data) else { return link.close() }
      let wasConnecting = !self.receivedState && self.model.notice == Self.connecting
      self.receivedState = true
      self.receive(state)
      if let awaiting = Self.awaitingSession, self.session?.isLive(now: KeyboardSession.nowMs()) == true {
        Self.awaitingSession = nil
        if Date().timeIntervalSince(awaiting.at) < Self.launchWindow,
           awaiting.mode == .agent || awaiting.document == self.keyboard?.engine.target.documentIdentifier {
          return self.start(awaiting.mode)
        }
      }
      if wasConnecting, self.model.notice == Self.connecting {
        if self.session?.isLive(now: KeyboardSession.nowMs()) == true {
          self.show("Connected. Tap again to start.")
        } else {
          self.show(Self.noSession)
        }
      }
    }
    link.onClose = { [weak self, weak link] in
      guard let self, let link, self.channel === link else { return }
      let endedNormally = self.receivedState && self.session == nil
      if link.refused || endedNormally { Self.deadToken = bridge.token }
      self.channel = nil
      self.bridge = nil
      self.pendingId = nil
      self.session = nil
      if self.receivedState, !endedNormally {
        self.log.error("KeyboardBridge connection lost")
        self.show("Keyboard connection lost. Open Shuddhalekhan and start a new session.")
      } else if !self.receivedState, self.model.notice == Self.connecting {
        // A stale discovery entry: the app's session ended while it was in the background.
        self.show(Self.noSession)
      }
      self.render()
    }
    link.start()
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.ackTimeout) { [weak self, weak link] in
      guard let self, let link, self.channel === link, !self.receivedState else { return }
      link.close()
    }
  }

  private func receive(_ state: KeyboardSession.State) {
    let previous = session
    session = state.isLive(now: KeyboardSession.nowMs()) || state.isBusy ? state : nil
    if let session, let language = session.language,
       previous?.language != language || previous?.style != session.style {
      UserDefaults.standard.set(language, forKey: Self.languageKey)
      UserDefaults.standard.set(session.style?.rawValue, forKey: Self.styleKey)
    }
    // Levels arrive up to 15 times a second while recording. They only repaint the dots, never the keyboard.
    if let previous, let session, session.phase == .recording, previous.phase == .recording,
       previous.requestId == session.requestId, previous.sessionEndsAt == session.sessionEndsAt,
       previous.agentReady == session.agentReady {
      if session.requestId == pendingId { keyboard?.pushLevel(CGFloat(session.level ?? 0)) }
      return
    }
    log.notice("KeyboardBridge received phase \(state.phase.rawValue, privacy: .public)")
    defer { render() }
    guard let pendingId, state.requestId == pendingId else {
      if session == nil {
        self.pendingId = nil
        if let error = state.error { show("Session ended. \(error)") }
      }
      return
    }
    if let text = KeyboardSession.insertion(state, pendingId: pendingId, inserted: insertedIds) {
      insertedIds.insert(pendingId)
      self.pendingId = nil
      guard pendingDocument == keyboard?.engine.target.documentIdentifier else {
        return show("The text field changed. Dictate again to insert here.")
      }
      insertDictation(text)
      log.notice("SpeechPerf keyboard stage=inserted id=\(pendingId, privacy: .public)")
      return
    }
    switch state.phase {
    case .done where state.mode == .agent:
      self.pendingId = nil
      show("Sent to the agent. Follow it in the Live Activity.")
    case .failed:
      self.pendingId = nil
      show(state.error ?? (pendingMode == .agent ? "Couldn't reach the agent. Try again." : "Dictation failed. Try again."))
    case .cancelled:
      // The keyboard's own cancel never gets here (it forgets the request first): this is the app ending it.
      self.pendingId = nil
      if let error = state.error { show(error) }
    case .done, .idle:
      self.pendingId = nil
    case .recording:
      keyboard?.pushLevel(CGFloat(state.level ?? 0))
    case .preparing, .transcribing:
      break
    }
  }

  private func start(_ mode: KeyboardSession.Mode) {
    guard pendingId == nil, localPhase == nil else { return }
    if channel == nil { refresh() }
    guard let session, session.isLive(now: KeyboardSession.nowMs()) else {
      if channel != nil && !receivedState { return show(Self.connecting) }
      // An expired session finishing its last utterance still holds the microphone.
      if self.session?.isBusy == true { return show("Shuddhalekhan is finishing the last dictation. Try again in a moment.") }
      guard hasFullAccess else { return show(Self.noSession) }
      if mode == .dictate, startLocally() { return }
      return openApp(mode)
    }
    if mode == .agent, !session.agentReady {
      return show("Set up Agent Mode in Shuddhalekhan to ask the agent from here.")
    }
    let id = UUID().uuidString
    pendingId = id
    pendingMode = mode
    // Read the field through the engine: UIKit's non-optional `documentIdentifier` can be nil and trap.
    pendingDocument = keyboard?.engine.target.documentIdentifier
    guard send(.start, id: id) else { pendingId = nil; return }
    clearNotice()
    render()
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.ackTimeout) { [weak self] in
      guard let self, self.pendingId == id, self.session?.requestId != id else { return }
      // A start the app reads late would otherwise record for nobody until the utterance cap.
      self.send(.cancel, id: id)
      self.pendingId = nil
      self.show("Shuddhalekhan didn't respond. Open the app to check the session.")
      self.render()
    }
  }

  private func openApp(_ mode: KeyboardSession.Mode) {
    Self.awaitingSession = (mode, Date(), keyboard?.engine.target.documentIdentifier)
    Self.deadToken = nil
    if !ContainingAppOpener.open(Self.sessionLink, from: self) {
      Self.awaitingSession = nil
      if model.notice != Self.downloadNotice { show(Self.noSession) }
    }
  }

  /// Dictates in the keyboard (iOS 26): with its own Parakeet where that fits in the keyboard's memory (downloaded on
  /// the first try), else with Apple's speech recognition, as Hex's keyboard does. False leaves it to the app: before
  /// iOS 26, or in a field UIKit can't name, which can't be told from the next one.
  private func startLocally() -> Bool {
    guard #available(iOS 26.0, *) else { return false }
    guard let document = keyboard?.engine.target.documentIdentifier else {
      log.notice("Keyboard dictation: unnamed field, opening the app")
      return false
    }
    // Until a session says the language, Apple's speech recognition in the iPhone's.
    let language = UserDefaults.standard.string(forKey: Self.languageKey)
    let parakeet = language.flatMap { try? ParakeetConfiguration(language: $0) }
    let memory = KeyboardParakeet.memory()
    let engine: KeyboardLocalDictation.Engine
    if let parakeet, KeyboardLocalDictation.canStart(parakeet) {
      engine = .parakeet(parakeet)
    } else if KeyboardLocalDictation.isDownloading {
      // Its notice holds the ✕, the only way to stop it.
      show(Self.downloadNotice)
      return true
    } else if let parakeet, !KeyboardParakeet.isInstalled(parakeet), KeyboardLocalDictation.canDownload {
      KeyboardLocalDictation.download(parakeet) { [weak self] ok in
        self?.show(ok ? "Ready. Tap Dictate to dictate right here." : "Couldn't download the speech model. Try again.")
      }
      // After the download starts, so this notice stays up with it.
      show(Self.downloadNotice)
      return true
    } else {
      // A Parakeet model held without the room to use it leaves its memory to this dictation.
      Task { await KeyboardParakeet.shared.release() }
      engine = .apple(language: language ?? "")
    }
    log.notice("Keyboard dictation engine=\(String(describing: engine), privacy: .public) language=\(language ?? "none", privacy: .public) footprint_mb=\(memory.footprint >> 20, privacy: .public) available_mb=\(memory.available >> 20, privacy: .public)")
    let local = self.local ?? makeLocal()
    pendingMode = .dictate
    pendingDocument = document
    let style = UserDefaults.standard.string(forKey: Self.styleKey).flatMap(DictationStyle.init(rawValue:)) ?? .legacy
    clearNotice()
    local.start(in: view, engine: engine, style: style)
    return true
  }

  private func makeLocal() -> KeyboardLocalDictation {
    let local = KeyboardLocalDictation()
    self.local = local
    local.onChange = { [weak self] in self?.render() }
    local.onLevel = { [weak self] in self?.keyboard?.pushLevel($0) }
    local.onText = { [weak self] text in
      guard let self else { return }
      guard self.pendingDocument == self.keyboard?.engine.target.documentIdentifier else {
        return self.show("The text field changed. Dictate again to insert here.")
      }
      self.insertDictation(text)
    }
    local.onFailure = { [weak self] message, beforeRecording in
      // The microphone never opened here (permission, or iOS refused it): the app's session still can.
      // A late one (the model loaded slowly) doesn't follow the user to another field.
      guard let self else { return }
      if beforeRecording, self.pendingDocument == self.keyboard?.engine.target.documentIdentifier {
        self.log.notice("Keyboard dictation failed before recording, opening the app: \(message, privacy: .public)")
        self.openApp(.dictate)
      } else {
        self.show(message)
      }
    }
    return local
  }

  private var localPhase: KeyboardViewModel.StagePhase? {
    switch local?.phase {
    case nil, .idle?: nil
    case .starting?: .starting
    case .recording?: .recording
    case .transcribing?: .transcribing
    }
  }

  /// ✓, or lifting a held voice key. The session only stops a recording; before one starts there is nothing to
  /// keep, and a transcription already under way finishes by itself.
  private func stop() {
    if localPhase != nil { return local?.stop() ?? () }
    guard let pendingId else { return }
    switch activePhase {
    case .recording?: send(.stop, id: pendingId)
    case .transcribing?: break
    default: cancel()
    }
  }

  /// Leaves at once; the app settles the request as cancelled, which this keyboard no longer waits for.
  private func cancel() {
    if localPhase != nil { return local?.cancel() ?? () }
    guard let pendingId else { return }
    send(.cancel, id: pendingId)
    self.pendingId = nil
    render()
  }

  private func setStyle(_ style: DictationStyle) {
    if channel == nil { refresh() }
    guard let channel, let bridge, let session, session.isLive(now: KeyboardSession.nowMs()) else {
      // The download's notice holds its ✕, the only way to stop it.
      if model.notice == Self.downloadNotice { return }
      return show(channel != nil && !receivedState ? Self.connecting : Self.noSession)
    }
    guard pendingId == nil, !session.isBusy else { return }
    channel.send(KeyboardSession.Request(token: bridge.token,
      command: .init(id: UUID().uuidString, action: .setStyle, mode: .dictate,
        sentAt: KeyboardSession.nowMs(), style: style)))
  }

  @discardableResult
  private func send(_ action: KeyboardSession.Command.Action, id: String) -> Bool {
    guard let channel, let bridge else {
      session = nil
      show("Keyboard connection unavailable. Open Shuddhalekhan and start a new session.")
      return false
    }
    log.notice("SpeechPerf keyboard stage=\(action.rawValue, privacy: .public) id=\(id, privacy: .public)")
    channel.send(KeyboardSession.Request(token: bridge.token,
      command: .init(id: id, action: action, mode: pendingMode, sentAt: KeyboardSession.nowMs())))
    return true
  }

  private var activePhase: KeyboardSession.State.Phase? {
    guard let pendingId, let session, session.requestId == pendingId, session.isBusy else { return nil }
    return session.phase
  }

  /// A two-thumb Dictate's words replace the range it picked first, so spacing reads the result; the strip then
  /// offers to take the dictation back.
  private func insertDictation(_ transcript: String) {
    guard let keyboard else { return }
    keyboard.engine.commitHangulComposition()
    keyboard.applyPendingSelectionDictation()
    let proxy = textDocumentProxy
    let document = keyboard.engine.target.documentIdentifier
    let before = proxy.documentContextBeforeInput
    let after = proxy.documentContextAfterInput
    let replacingSelection = !(proxy.selectedText?.isEmpty ?? true)
    let insertion = KeyboardInsertion.text(transcript,
      before: replacingSelection ? nil : before, after: replacingSelection ? nil : after)
    proxy.insertText(insertion)
    // Undo only for an insert the host confirms, never over a replaced selection.
    keyboard.didInsertDictation(undo: replacingSelection ? nil : DictationUndo(text: insertion,
      document: document, before: before, after: after, resultingDocument: keyboard.engine.target.documentIdentifier,
      resultingBefore: proxy.documentContextBeforeInput, resultingAfter: proxy.documentContextAfterInput))
  }

  // MARK: Model

  /// Publishes only what changed: every assignment refreshes the whole keyboard.
  private func render() {
    let stage: KeyboardViewModel.StagePhase = switch (localPhase, pendingId, activePhase) {
    case (let local?, _, _): local
    case (nil, nil, _): .idle
    case (nil, _, .recording?): .recording
    case (nil, _, .transcribing?): .transcribing
    default: .starting
    }
    if model.stagePhase != stage { model.stagePhase = stage }
    if model.mode != pendingMode { model.mode = pendingMode }
    if model.style != session?.style { model.style = session?.style }
  }

  /// One line in the strip, over the suggestions, until the next keystroke, ✕, or a few seconds pass.
  private func show(_ notice: String) {
    model.notice = notice
    // A hidden keyboard (a download ending) keeps the notice for its return, but says nothing.
    if view.window != nil { UIAccessibility.post(notification: .announcement, argument: notice) }
    noticeWork?.cancel()
    // A download's notice stays up until it ends.
    guard notice != Self.downloadNotice else { return }
    let work = DispatchWorkItem { [weak self] in self?.clearNotice() }
    noticeWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.noticeDuration, execute: work)
  }

  private static let downloadNotice = "Downloading the speech model (several hundred MB). Keep the keyboard open…"

  private func clearNotice() {
    noticeWork?.cancel()
    noticeWork = nil
    if model.notice != nil { model.notice = nil }
  }
}

/// `UIDevice.playInputClick()` plays only while the visible input view adopts `UIInputViewAudioFeedback`; a
/// subview that adopts it plays nothing (UIKit's docs).
private final class ClickingInputView: UIInputView, UIInputViewAudioFeedback {
  var enableInputClicksWhenVisible: Bool { true }
}
