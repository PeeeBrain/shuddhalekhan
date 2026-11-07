import UIKit
import Network
import OSLog

/// Voice keyboard with no letter keys. It never records: it asks the Shuddhalekhan app's active keyboard session
/// to record, then either inserts that request's transcript at the cursor (Dictate) or leaves it to the app, which
/// hands it to Agent Mode (Ask the agent). See KeyboardSessionProtocol.swift.
///
/// Home shows the two actions as the desktop recording pills: Dictate round and blue, Agent square and vermilion.
/// Tapping one grows that row into an inset shutter (big stop button, cancel, delete, live levels), and the
/// shutter collapses back into the same row when the request settles.
final class KeyboardViewController: UIInputViewController {
  private static let ackTimeout: TimeInterval = 3
  private static let sentHold: TimeInterval = 1.6
  private static let startIntentKey = "keyboardSessionStartIntent"

  private enum Screen: Equatable { case home, live(KeyboardSession.Mode) }

  // Home
  private let home = UIStackView()
  private let statusLabel = UILabel()
  private let clockLabel = UILabel()
  private lazy var statusHeight = statusLabel.heightAnchor.constraint(equalToConstant: 0)
  private let dictateRow = ActionRow(mode: .dictate)
  private let agentRow = ActionRow(mode: .agent)
  private let globeKey = PressControl()

  // Live: the tapped row grows into an inset card; live holds the shutter controls above it.
  private let surface = UIView()
  private let live = UIStackView()
  private let liveTop = UIStackView()
  private let liveStatus = UILabel()
  private let liveClock = UILabel()
  private let stage = UIView()
  private let bars = LevelBars()
  private let sentStack = UIStackView()
  private let sentText = UILabel()
  private var cancelSide = UIStackView()
  private var deleteSide = UIStackView()
  private let shutterHost = UIView()
  private let shutterRing = UIView()
  private let shutter = PressControl()
  private let stopGlyph = UIView()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let checkGlyph = UIImageView(image: UIImage(systemName: "checkmark",
    withConfiguration: UIImage.SymbolConfiguration(pointSize: 30, weight: .bold)))

  private var screen = Screen.home
  private var generation = 0
  private let tapFeedback = UIImpactFeedbackGenerator(style: .light)
  private var deleteRepeat: Timer?

  private var session: KeyboardSession.State?
  private var pendingId: String?
  private var pendingMode = KeyboardSession.Mode.dictate
  private var recordingSince: Date?
  /// An agent request that just landed, held on screen briefly as confirmation.
  private var sent: (id: String, text: String)?
  private var insertedIds = Set<String>()
  private var clock: Timer?
  private var channel: KeyboardSessionChannel?
  private var bridge: KeyboardSession.Bridge?
  private var receivedState = false
  private var openingSession = false
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "KeyboardBridge")

  override func viewDidLoad() {
    super.viewDidLoad()
    view.overrideUserInterfaceStyle = .dark
    view.backgroundColor = .clear
    view.isOpaque = false
    view.maximumContentSizeCategory = .extraLarge
    // Below required so it never fights the system's own keyboard height constraint while appearing.
    let height = view.heightAnchor.constraint(equalToConstant: 262)
    height.priority = UILayoutPriority(rawValue: 999)
    height.isActive = true

    surface.isHidden = true
    surface.layer.cornerCurve = .continuous
    surface.isUserInteractionEnabled = false
    view.addSubview(surface)
    buildHome()
    buildLive()
    render()
  }

  override func viewWillLayoutSubviews() {
    super.viewWillLayoutSubviews()
    let twoLines = ceil(statusLabel.font.lineHeight * 2)
    if statusHeight.constant != twoLines { statusHeight.constant = twoLines }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    // Rotation or a height change while live: keep the card inset, unless it is mid-morph.
    if case .live = screen, surface.layer.animationKeys() == nil { surface.frame = liveFrame }
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    log.notice("SpeechPerf keyboard stage=appear")
    globeKey.isHidden = !needsInputModeSwitchKey
    // Updates only the countdown and elapsed text while the keyboard is on screen.
    clock = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
    tapFeedback.prepare()
    refresh()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    // Closing the authenticated connection cancels its utterance on the app side.
    if let pendingId { send(.cancel, id: pendingId) }
    pendingId = nil
    sent = nil
    stopDeleting()
    clock?.invalidate()
    clock = nil
    disconnect()
    resetToHome()
  }

  // MARK: Layout

  private func buildHome() {
    home.axis = .vertical
    home.spacing = 8
    home.isLayoutMarginsRelativeArrangement = true
    home.layoutMargins = UIEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
    pin(home)

    statusLabel.font = scaledFont(12, .regular, .footnote)
    statusLabel.adjustsFontForContentSizeCategory = true
    statusLabel.textColor = Palette.faded
    statusLabel.numberOfLines = 2
    // Always reserves two lines (see viewWillLayoutSubviews) so status changes never move the rows.
    statusHeight.isActive = true
    styleClock(clockLabel, color: Palette.faded)
    let statusRow = UIStackView(arrangedSubviews: [statusLabel, clockLabel])
    statusRow.spacing = 8
    statusRow.isLayoutMarginsRelativeArrangement = true
    statusRow.layoutMargins = UIEdgeInsets(top: 0, left: 4, bottom: 0, right: 4)
    home.addArrangedSubview(statusRow)

    for row in [dictateRow, agentRow] {
      row.heightAnchor.constraint(equalToConstant: 64).isActive = true
      home.addArrangedSubview(row)
    }
    dictateRow.addTarget(self, action: #selector(dictateTapped), for: .touchUpInside)
    agentRow.addTarget(self, action: #selector(agentTapped), for: .touchUpInside)

    styleKey(globeKey, symbol: "globe", label: "Next keyboard")
    globeKey.addTarget(self, action: #selector(handleInputModeList(from:with:)), for: .allTouchEvents)
    let backspace = PressControl()
    styleKey(backspace, symbol: "delete.left", label: "Delete")
    wireDelete(backspace)
    let spacer = UIView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let keys = UIStackView(arrangedSubviews: [globeKey, spacer, backspace])
    keys.alignment = .bottom
    keys.setContentHuggingPriority(.defaultLow, for: .vertical)
    home.addArrangedSubview(keys)
  }

  private func buildLive() {
    live.axis = .vertical
    live.isLayoutMarginsRelativeArrangement = true
    live.layoutMargins = UIEdgeInsets(top: 16, left: 24, bottom: 22, right: 24)
    live.isHidden = true
    pin(live)

    liveStatus.font = scaledFont(13, .semibold, .footnote)
    liveStatus.adjustsFontForContentSizeCategory = true
    styleClock(liveClock, color: Palette.faded)
    liveTop.addArrangedSubview(liveStatus)
    liveTop.addArrangedSubview(liveClock)
    liveTop.spacing = 8
    live.addArrangedSubview(liveTop)

    // Levels and the sent confirmation share the stage and cross-fade.
    stage.setContentHuggingPriority(.defaultLow, for: .vertical)
    live.addArrangedSubview(stage)
    bars.translatesAutoresizingMaskIntoConstraints = false
    stage.addSubview(bars)
    sentText.font = scaledFont(16, .medium, .body)
    sentText.adjustsFontForContentSizeCategory = true
    sentText.textColor = Palette.parchment
    sentText.numberOfLines = 2
    sentText.textAlignment = .center
    let sentHint = UILabel()
    sentHint.text = "Follow it in the Live Activity."
    sentHint.font = scaledFont(12, .regular, .footnote)
    sentHint.adjustsFontForContentSizeCategory = true
    sentHint.textColor = Palette.faded
    sentStack.addArrangedSubview(sentText)
    sentStack.addArrangedSubview(sentHint)
    sentStack.axis = .vertical
    sentStack.alignment = .center
    sentStack.spacing = 6
    sentStack.alpha = 0
    sentStack.translatesAutoresizingMaskIntoConstraints = false
    stage.addSubview(sentStack)
    NSLayoutConstraint.activate([
      bars.centerXAnchor.constraint(equalTo: stage.centerXAnchor),
      bars.centerYAnchor.constraint(equalTo: stage.centerYAnchor),
      bars.heightAnchor.constraint(equalToConstant: 36),
      sentStack.centerYAnchor.constraint(equalTo: stage.centerYAnchor),
      sentStack.leadingAnchor.constraint(equalTo: stage.leadingAnchor, constant: 8),
      sentStack.trailingAnchor.constraint(equalTo: stage.trailingAnchor, constant: -8),
    ])

    shutterHost.translatesAutoresizingMaskIntoConstraints = false
    shutterRing.translatesAutoresizingMaskIntoConstraints = false
    shutterRing.isUserInteractionEnabled = false
    shutterRing.layer.cornerCurve = .continuous
    shutter.translatesAutoresizingMaskIntoConstraints = false
    shutter.pressedScale = 0.92
    shutter.layer.cornerCurve = .continuous
    shutter.isAccessibilityElement = true
    shutter.accessibilityTraits = .button
    shutter.addTarget(self, action: #selector(shutterTapped), for: .touchUpInside)
    shutterHost.addSubview(shutterRing)
    shutterHost.addSubview(shutter)
    stopGlyph.backgroundColor = Palette.onSignal
    stopGlyph.layer.cornerRadius = 6
    stopGlyph.layer.cornerCurve = .continuous
    spinner.color = Palette.onSignal
    spinner.hidesWhenStopped = true
    checkGlyph.tintColor = Palette.onSignal
    checkGlyph.isHidden = true
    for glyph in [stopGlyph, spinner, checkGlyph] {
      glyph.translatesAutoresizingMaskIntoConstraints = false
      glyph.isUserInteractionEnabled = false
      shutter.addSubview(glyph)
      glyph.centerXAnchor.constraint(equalTo: shutter.centerXAnchor).isActive = true
      glyph.centerYAnchor.constraint(equalTo: shutter.centerYAnchor).isActive = true
    }
    NSLayoutConstraint.activate([
      shutterHost.widthAnchor.constraint(equalToConstant: 96),
      shutterHost.heightAnchor.constraint(equalToConstant: 96),
      shutter.topAnchor.constraint(equalTo: shutterHost.topAnchor),
      shutter.bottomAnchor.constraint(equalTo: shutterHost.bottomAnchor),
      shutter.leadingAnchor.constraint(equalTo: shutterHost.leadingAnchor),
      shutter.trailingAnchor.constraint(equalTo: shutterHost.trailingAnchor),
      shutterRing.topAnchor.constraint(equalTo: shutterHost.topAnchor, constant: -6),
      shutterRing.bottomAnchor.constraint(equalTo: shutterHost.bottomAnchor, constant: 6),
      shutterRing.leadingAnchor.constraint(equalTo: shutterHost.leadingAnchor, constant: -6),
      shutterRing.trailingAnchor.constraint(equalTo: shutterHost.trailingAnchor, constant: 6),
      stopGlyph.widthAnchor.constraint(equalToConstant: 28),
      stopGlyph.heightAnchor.constraint(equalToConstant: 28),
    ])

    let (cancelSide, cancel) = sideKey("xmark", caption: "Cancel", tint: Palette.faded)
    cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    let (deleteSide, delete) = sideKey("delete.left", caption: "Delete", tint: Palette.parchment)
    wireDelete(delete)
    self.cancelSide = cancelSide
    self.deleteSide = deleteSide
    let shutterRow = UIStackView(arrangedSubviews: [cancelSide, shutterHost, deleteSide])
    shutterRow.distribution = .equalSpacing
    shutterRow.alignment = .center
    live.addArrangedSubview(shutterRow)
  }

  private func pin(_ child: UIView) {
    view.addSubview(child)
    child.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      child.topAnchor.constraint(equalTo: view.topAnchor),
      child.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      child.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      child.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
  }

  private func styleClock(_ label: UILabel, color: UIColor) {
    label.font = scaledFont(13, .semibold, .footnote, monospacedDigits: true)
    label.adjustsFontForContentSizeCategory = true
    label.textColor = color
    label.setContentHuggingPriority(.required, for: .horizontal)
    label.setContentCompressionResistancePriority(.required, for: .horizontal)
  }

  private func styleKey(_ key: PressControl, symbol: String, label: String) {
    key.restingColor = Palette.ash
    key.pressedColor = Palette.ashPressed
    key.layer.cornerRadius = 8
    key.layer.cornerCurve = .continuous
    key.isAccessibilityElement = true
    key.accessibilityLabel = label
    key.accessibilityTraits = .button
    addCentered(UIImageView(image: UIImage(systemName: symbol,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular))), to: key, tint: Palette.parchment)
    key.widthAnchor.constraint(equalToConstant: 52).isActive = true
    key.heightAnchor.constraint(equalToConstant: 42).isActive = true
  }

  private func sideKey(_ symbol: String, caption: String, tint: UIColor) -> (UIStackView, PressControl) {
    let key = PressControl()
    key.restingColor = Palette.ash
    key.pressedColor = Palette.ashPressed
    key.layer.cornerRadius = 28
    key.isAccessibilityElement = true
    key.accessibilityLabel = caption
    key.accessibilityTraits = .button
    addCentered(UIImageView(image: UIImage(systemName: symbol,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .medium))), to: key, tint: tint)
    key.widthAnchor.constraint(equalToConstant: 56).isActive = true
    key.heightAnchor.constraint(equalToConstant: 56).isActive = true
    let label = UILabel()
    label.text = caption
    label.font = scaledFont(11, .medium, .caption2)
    label.textColor = Palette.faded
    label.isAccessibilityElement = false
    let side = UIStackView(arrangedSubviews: [key, label])
    side.axis = .vertical
    side.alignment = .center
    side.spacing = 5
    side.widthAnchor.constraint(equalToConstant: 64).isActive = true
    return (side, key)
  }

  private func addCentered(_ image: UIImageView, to key: UIView, tint: UIColor) {
    image.tintColor = tint
    image.translatesAutoresizingMaskIntoConstraints = false
    key.addSubview(image)
    image.centerXAnchor.constraint(equalTo: key.centerXAnchor).isActive = true
    image.centerYAnchor.constraint(equalTo: key.centerYAnchor).isActive = true
  }

  // MARK: Session

  private func disconnect() {
    let previous = channel
    channel = nil
    bridge = nil
    session = nil
    previous?.close()
  }

  private func refresh() {
    resumePendingStart()
    guard hasFullAccess else {
      disconnect()
      session = nil
      render(message: "Turn on Allow Full Access for Shuddhalekhan in Settings > General > Keyboard > Keyboards. It connects only to the app on this iPhone.")
      return
    }
    if channel != nil { return }
    guard let data = UIPasteboard(name: UIPasteboard.Name(KeyboardSession.discoveryPasteboard), create: false)?
      .data(forPasteboardType: KeyboardSession.payloadType),
      let bridge = KeyboardSession.decodeBridge(data, now: KeyboardSession.nowMs()),
      let port = NWEndpoint.Port(rawValue: bridge.port) else {
      session = nil
      render(message: "Tap Dictate or Ask the agent to open Shuddhalekhan and start a session.")
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
      self.receivedState = true
      self.receive(state)
    }
    link.onClose = { [weak self, weak link] in
      guard let self, let link, self.channel === link else { return }
      let endedNormally = self.receivedState && self.session == nil
      self.channel = nil
      self.bridge = nil
      self.pendingId = nil
      self.session = nil
      if !self.receivedState {
        self.render(message: "Tap Dictate or Ask the agent to open Shuddhalekhan and start a session.")
        if let intent = self.pendingStartIntent() { self.openSession(for: intent.mode) }
      } else if endedNormally { self.render() } else {
        self.log.error("KeyboardBridge connection lost")
        self.render(message: "Keyboard connection lost. Open Shuddhalekhan and start a new session.")
      }
    }
    render(message: "Connecting to Shuddhalekhan…")
    link.start()
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.ackTimeout) { [weak self, weak link] in
      guard let self, let link, self.channel === link, !self.receivedState else { return }
      link.close()
    }
  }

  private func receive(_ state: KeyboardSession.State) {
    let previous = session
    session = state.isLive(now: KeyboardSession.nowMs()) || state.isBusy ? state : nil
    // Levels arrive up to 15 times a second while recording. They only move the bars, never relayout.
    if let previous, let session, session.phase == .recording, previous.phase == .recording,
       previous.requestId == session.requestId, previous.sessionEndsAt == session.sessionEndsAt,
       previous.agentReady == session.agentReady {
      if session.requestId == pendingId { bars.push(CGFloat(session.level ?? 0)) }
      return
    }
    log.notice("KeyboardBridge received phase \(state.phase.rawValue, privacy: .public)")
    guard let pendingId, state.requestId == pendingId else {
      if session == nil { pendingId = nil }
      render(message: session == nil ? state.error.map { "Session ended. \($0)" } : nil)
      resumePendingStart()
      return
    }
    if let text = KeyboardSession.insertion(state, pendingId: pendingId, inserted: insertedIds) {
      insertedIds.insert(pendingId)
      self.pendingId = nil
      textDocumentProxy.insertText(text)
      log.notice("SpeechPerf keyboard stage=inserted id=\(pendingId, privacy: .public)")
      render(message: "Inserted.")
      return
    }
    switch state.phase {
    case .done where state.mode == .agent:
      self.pendingId = nil
      holdSent(id: pendingId, text: state.text ?? "")
    case .failed:
      self.pendingId = nil
      render(message: state.error ?? (pendingMode == .agent ? "Couldn't reach the agent. Try again." : "Dictation failed. Try again."))
    case .cancelled, .done, .idle:
      self.pendingId = nil
      render()
    case .recording:
      if recordingSince == nil { recordingSince = Date() }
      bars.push(CGFloat(state.level ?? 0))
      render()
    case .transcribing:
      render()
    }
  }

  private func holdSent(id: String, text: String) {
    sent = (id, text)
    render()
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.sentHold) { [weak self] in
      guard let self, self.sent?.id == id else { return }
      self.sent = nil
      self.render(message: "Sent to the agent. Follow it in the Live Activity.")
    }
  }

  @objc private func dictateTapped() { start(.dictate) }
  @objc private func agentTapped() { start(.agent) }

  private func start(_ mode: KeyboardSession.Mode) {
    guard hasFullAccess else { return refresh() }
    guard pendingId == nil, sent == nil else { return }
    guard let session, session.isLive(now: KeyboardSession.nowMs()) else {
      if channel != nil, !receivedState {
        _ = persistStartIntent(for: mode)
        return
      }
      disconnect()
      return openSession(for: mode)
    }
    if mode == .agent, !session.agentReady {
      return render(message: "Set up Agent Mode in Shuddhalekhan to ask the agent from here.")
    }
    let id = UUID().uuidString
    pendingId = id
    pendingMode = mode
    recordingSince = nil
    guard send(.start, id: id) else { pendingId = nil; return }
    tapFeedback.impactOccurred()
    render()
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.ackTimeout) { [weak self] in
      guard let self, self.pendingId == id, self.session?.requestId != id else { return }
      // A start the app reads late would otherwise record for nobody until the utterance cap.
      self.send(.cancel, id: id)
      self.pendingId = nil
      self.render(message: "Shuddhalekhan didn't respond. Open the app to check the session.")
    }
  }

  private func persistStartIntent(for mode: KeyboardSession.Mode) -> Data? {
    let intent = KeyboardSession.StartIntent(mode: mode, createdAt: KeyboardSession.nowMs())
    guard let data = KeyboardSession.encode(intent) else { return nil }
    UserDefaults.standard.set(data, forKey: Self.startIntentKey)
    return data
  }

  private func openSession(for mode: KeyboardSession.Mode) {
    guard !openingSession, let url = URL(string: "shuddhalekhan://keyboard-session"),
      let data = persistStartIntent(for: mode) else { return }
    var responder: UIResponder? = self
    while let current = responder {
      if let application = current as? UIApplication {
        openingSession = true
        application.open(url, options: [:]) { [weak self] opened in
          MainActor.assumeIsolated {
            self?.openingSession = false
            if !opened { self?.sessionOpenFailed(intent: data) }
          }
        }
        return
      }
      responder = current.next
    }
    sessionOpenFailed(intent: data)
  }

  private func sessionOpenFailed(intent: Data) {
    if UserDefaults.standard.data(forKey: Self.startIntentKey) == intent {
      UserDefaults.standard.removeObject(forKey: Self.startIntentKey)
    }
    render(message: "Open Shuddhalekhan and tap Start keyboard session.")
  }

  private func pendingStartIntent() -> KeyboardSession.StartIntent? {
    let defaults = UserDefaults.standard
    guard let data = defaults.data(forKey: Self.startIntentKey) else { return nil }
    guard let intent = try? JSONDecoder().decode(KeyboardSession.StartIntent.self, from: data),
      intent.isFresh(now: KeyboardSession.nowMs()) else {
      defaults.removeObject(forKey: Self.startIntentKey)
      return nil
    }
    return intent
  }

  private func resumePendingStart() {
    guard let intent = pendingStartIntent() else { return }
    guard hasFullAccess, let session, session.isLive(now: KeyboardSession.nowMs()),
      !session.isBusy, pendingId == nil, sent == nil else { return }
    // Consume before start: reconnects and appearance callbacks cannot replay this intent twice.
    UserDefaults.standard.removeObject(forKey: Self.startIntentKey)
    start(intent.mode)
  }

  @objc private func shutterTapped() {
    if sent != nil {
      sent = nil
      return render(message: "Sent to the agent. Follow it in the Live Activity.")
    }
    guard let pendingId, activePhase == .recording else { return }
    tapFeedback.impactOccurred()
    send(.stop, id: pendingId)
  }

  /// Leaves at once; the app settles the request as cancelled, which this keyboard no longer waits for.
  @objc private func cancelTapped() {
    guard let pendingId else { return }
    send(.cancel, id: pendingId)
    self.pendingId = nil
    render()
  }

  @discardableResult
  private func send(_ action: KeyboardSession.Command.Action, id: String) -> Bool {
    guard let channel, let bridge else {
      session = nil
      render(message: "Keyboard connection unavailable. Open Shuddhalekhan and start a new session.")
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

  // MARK: Render

  private func render(message: String? = nil) {
    let target: Screen = pendingId != nil || sent != nil ? .live(pendingMode) : .home
    if target != screen { show(target) }

    let agentReady = session?.agentReady ?? false
    dictateRow.isAvailable = hasFullAccess
    agentRow.isAvailable = hasFullAccess && (session == nil || agentReady)
    agentRow.subtitle = session == nil || agentReady
      ? "One-off command · follow the Live Activity" : "Set up Agent Mode in the app first"
    announce(message ?? (session == nil ? "Tap an action to open Shuddhalekhan and start a session." : "Keyboard session"), in: statusLabel)

    if case .live(let mode) = screen { renderLive(mode) }
    tick()
  }

  private func renderLive(_ mode: KeyboardSession.Mode) {
    let phase = activePhase
    let accent = mode == .agent ? Palette.vermilion : Palette.blue
    let status: String
    var statusColor = Palette.faded
    if sent != nil {
      status = "Sent to the agent"
      statusColor = accent
    } else {
      switch phase {
      case .recording?:
        status = mode == .agent ? "Listening for a command…" : "Listening…"
        statusColor = accent
      case .transcribing?: status = "Transcribing on this iPhone…"
      default: status = "Starting…"
      }
    }
    liveStatus.textColor = statusColor
    announce(status, in: liveStatus)

    if phase != .recording { bars.settle() }
    if let sent { sentText.text = "“\(sent.text)”" }
    let recording = phase == .recording
    let transcribing = phase == .transcribing && sent == nil
    UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
      self.bars.alpha = self.sent != nil ? 0 : (recording ? 1 : 0.35)
      self.sentStack.alpha = self.sent != nil ? 1 : 0
      self.stopGlyph.alpha = self.sent != nil || transcribing ? 0 : (recording ? 1 : 0.5)
      self.cancelSide.alpha = self.sent != nil ? 0.35 : 1
    }
    UIView.transition(with: shutter, duration: 0.18, options: [.transitionCrossDissolve, .allowUserInteraction]) {
      self.checkGlyph.isHidden = self.sent == nil
      if transcribing { self.spinner.startAnimating() } else { self.spinner.stopAnimating() }
    }
    shutter.isUserInteractionEnabled = recording || sent != nil
    shutter.accessibilityLabel = sent != nil ? "Done"
      : transcribing ? "Transcribing"
      : mode == .agent ? "Stop and send to the agent" : "Stop and insert"
  }

  private func announce(_ text: String, in label: UILabel) {
    guard label.text != text else { return }
    label.text = text
    UIAccessibility.post(notification: .announcement, argument: text)
  }

  private func tick() {
    if let session {
      let remaining = max(0, Int((session.sessionEndsAt - KeyboardSession.nowMs()) / 1_000))
      setClock(clockLabel, remaining, label: "\(remaining / 60) minutes \(remaining % 60) seconds left in the keyboard session")
    } else {
      clockLabel.text = nil
    }
    let phase = activePhase
    if phase == .recording, let recordingSince {
      let elapsed = Int(Date().timeIntervalSince(recordingSince))
      setClock(liveClock, elapsed, label: "Recording \(elapsed / 60) minutes \(elapsed % 60) seconds")
    } else if phase != .transcribing {
      liveClock.text = nil
    }
  }

  private func setClock(_ label: UILabel, _ seconds: Int, label accessibility: String) {
    let text = String(format: "%d:%02d", seconds / 60, seconds % 60)
    guard label.text != text else { return }
    label.text = text
    label.accessibilityLabel = accessibility
  }

  // MARK: Motion

  private func row(for mode: KeyboardSession.Mode) -> ActionRow { mode == .agent ? agentRow : dictateRow }

  private func styleLive(_ mode: KeyboardSession.Mode) {
    let agent = mode == .agent
    let accent = agent ? Palette.vermilion : Palette.blue
    // Same shape language as home: round for Dictate, squared for Agent.
    shutter.layer.cornerRadius = agent ? 14 : 48
    shutterRing.layer.cornerRadius = agent ? 20 : 54
    shutter.restingColor = accent
    shutter.pressedColor = accent.mixed(with: .black, 0.18)
    shutterRing.backgroundColor = accent.withAlphaComponent(0.18)
    bars.color = accent
  }

  private func liveBackground(_ mode: KeyboardSession.Mode) -> UIColor {
    mode == .agent ? Palette.soot.mixed(with: Palette.vermilion, 0.05) : Palette.soot
  }

  private var liveFrame: CGRect { view.bounds.insetBy(dx: 10, dy: 8) }

  /// The row's resting frame in tray coordinates, ignoring any press scale still settling on it.
  private func restingFrame(of row: ActionRow) -> CGRect {
    CGRect(x: row.center.x - row.bounds.width / 2, y: row.center.y - row.bounds.height / 2,
           width: row.bounds.width, height: row.bounds.height)
  }

  /// Puts the shutter exactly over the row's glyph well, so the well appears to become the stop button.
  private func wellTransform(for row: ActionRow) -> CGAffineTransform {
    let origin = restingFrame(of: row).origin
    let well = row.well.convert(row.well.bounds, to: row).offsetBy(dx: origin.x, dy: origin.y)
    guard let container = shutterHost.superview, shutterHost.bounds.width > 0 else { return .identity }
    let center = container.convert(shutterHost.center, to: live)
    let scale = well.width / shutterHost.bounds.width
    return CGAffineTransform(translationX: well.midX - center.x, y: well.midY - center.y).scaledBy(x: scale, y: scale)
  }

  private func setChrome(visible: Bool) {
    liveTop.alpha = visible ? 1 : 0
    liveTop.transform = visible ? .identity : CGAffineTransform(translationX: 0, y: -6)
    stage.alpha = visible ? 1 : 0
    stage.transform = visible ? .identity : CGAffineTransform(scaleX: 0.9, y: 0.9)
    // The side keys slide out from behind the shutter.
    deleteSide.alpha = visible ? 1 : 0
    deleteSide.transform = visible ? .identity : CGAffineTransform(translationX: -40, y: 0).scaledBy(x: 0.8, y: 0.8)
    cancelSide.transform = visible ? .identity : CGAffineTransform(translationX: 40, y: 0).scaledBy(x: 0.8, y: 0.8)
    if !visible { cancelSide.alpha = 0 } else if sent == nil { cancelSide.alpha = 1 }
  }

  /// Critically damped springs throughout, all additive, so a tap mid-flight retargets from wherever things are.
  private func show(_ target: Screen) {
    let from = screen
    screen = target
    generation += 1
    let generation = generation
    view.layoutIfNeeded()
    let reduceMotion = UIAccessibility.isReduceMotionEnabled

    switch target {
    case .live(let mode):
      let row = row(for: mode)
      styleLive(mode)
      let fresh = live.isHidden
      live.isHidden = false
      live.isUserInteractionEnabled = true
      surface.isHidden = false
      // The shutter's resting place is needed before it can start on the row's glyph well.
      live.layoutIfNeeded()
      if reduceMotion {
        if fresh {
          surface.alpha = 0
          live.alpha = 0
        }
        surface.frame = liveFrame
        surface.layer.cornerRadius = 14
        surface.backgroundColor = liveBackground(mode)
        shutterHost.transform = .identity
        shutterHost.alpha = 1
        setChrome(visible: true)
        fade(0.2) {
          self.surface.alpha = 1
          self.live.alpha = 1
          self.home.alpha = 0
        }
        return
      }
      if fresh {
        // Start exactly on the tapped row (under home), so the growth reads as that row expanding.
        surface.alpha = 1
        live.alpha = 1
        surface.frame = restingFrame(of: row)
        surface.layer.cornerRadius = row.layer.cornerRadius
        surface.backgroundColor = row.restingColor
        shutterHost.transform = wellTransform(for: row)
        // The tinted well fills in as it grows, rather than a solid button popping over it.
        shutterHost.alpha = 0
        setChrome(visible: false)
      }
      spring(0.42) {
        self.surface.frame = self.liveFrame
        self.surface.layer.cornerRadius = 14
        self.surface.backgroundColor = self.liveBackground(mode)
      }
      fade(0.16) { self.home.alpha = 0 }
      fade(0.18) { self.shutterHost.alpha = 1 }
      spring(0.5, bounce: 0.12) { self.shutterHost.transform = .identity }
      spring(0.42, delay: 0.06) { self.setChrome(visible: true) }

    case .home:
      guard case .live(let mode) = from else { return }
      let row = row(for: mode)
      // Home rows take taps the moment the shutter starts folding away.
      live.isUserInteractionEnabled = false
      let finish: (Bool) -> Void = { [weak self] _ in
        guard let self, self.generation == generation else { return }
        self.surface.isHidden = true
        self.live.isHidden = true
        self.shutterHost.transform = .identity
        self.bars.settle()
      }
      if reduceMotion {
        fade(0.2, {
          self.surface.alpha = 0
          self.live.alpha = 0
          self.home.alpha = 1
        }, completion: finish)
        return
      }
      spring(0.38, {
        self.surface.frame = self.restingFrame(of: row)
        self.surface.layer.cornerRadius = row.layer.cornerRadius
        self.surface.backgroundColor = row.restingColor
      }, completion: finish)
      spring(0.36) { self.shutterHost.transform = self.wellTransform(for: row) }
      fade(0.2, delay: 0.1) { self.shutterHost.alpha = 0 }
      spring(0.26) { self.setChrome(visible: false) }
      fade(0.24, delay: 0.08) { self.home.alpha = 1 }
    }
  }

  private func resetToHome() {
    generation += 1
    screen = .home
    for layer in [surface.layer, home.layer, live.layer, shutterHost.layer] { layer.removeAllAnimations() }
    surface.isHidden = true
    live.isHidden = true
    home.alpha = 1
    shutterHost.transform = .identity
    bars.settle()
    render()
  }

  private func spring(_ duration: TimeInterval, bounce: CGFloat = 0, delay: TimeInterval = 0,
                      _ animations: @escaping () -> Void, completion: ((Bool) -> Void)? = nil) {
    UIView.animate(springDuration: duration, bounce: bounce, initialSpringVelocity: 0, delay: delay,
      options: [.allowUserInteraction, .beginFromCurrentState], animations: animations, completion: completion)
  }

  private func fade(_ duration: TimeInterval, delay: TimeInterval = 0,
                    _ animations: @escaping () -> Void, completion: ((Bool) -> Void)? = nil) {
    UIView.animate(withDuration: duration, delay: delay,
      options: [.curveEaseOut, .allowUserInteraction, .beginFromCurrentState], animations: animations, completion: completion)
  }

  // MARK: Delete

  /// Deletes on touch down, then repeats while held, like the system delete key.
  private func wireDelete(_ key: PressControl) {
    key.addTarget(self, action: #selector(deleteDown), for: .touchDown)
    key.addTarget(self, action: #selector(stopDeleting), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
    key.accessibilityAction = { [weak self] in self?.textDocumentProxy.deleteBackward() }
  }

  @objc private func deleteDown() {
    textDocumentProxy.deleteBackward()
    deleteRepeat?.invalidate()
    deleteRepeat = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.deleteRepeat = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
          MainActor.assumeIsolated { self?.textDocumentProxy.deleteBackward() }
        }
      }
    }
  }

  @objc private func stopDeleting() {
    deleteRepeat?.invalidate()
    deleteRepeat = nil
  }
}

// MARK: - Views

/// DESIGN.md tokens. Slate Blue is Dictation only; Vermilion is Agent only.
@MainActor
private enum Palette {
  static let soot = UIColor(rgb: 0x191715)
  static let ash = UIColor(rgb: 0x262422)
  static let ashPressed = UIColor(rgb: 0x312E2B)
  static let hairline = UIColor(rgb: 0x393632)
  static let parchment = UIColor(rgb: 0xF1EFE9)
  static let faded = UIColor(rgb: 0x9C958B)
  static let onSignal = UIColor(rgb: 0x141210)
  static let blue = UIColor(rgb: 0x719ED6)
  static let vermilion = UIColor(rgb: 0xE08652)
}

private extension UIColor {
  convenience init(rgb: UInt32) {
    self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
              blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
  }

  func mixed(with other: UIColor, _ amount: CGFloat) -> UIColor {
    var (r1, g1, b1, a1, r2, g2, b2, a2) = (CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0))
    getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
    other.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
    return UIColor(red: r1 + (r2 - r1) * amount, green: g1 + (g2 - g1) * amount,
                   blue: b1 + (b2 - b1) * amount, alpha: a1 + (a2 - a1) * amount)
  }
}

private func scaledFont(_ size: CGFloat, _ weight: UIFont.Weight, _ style: UIFont.TextStyle,
                        monospacedDigits: Bool = false) -> UIFont {
  let base: UIFont = monospacedDigits ? .monospacedDigitSystemFont(ofSize: size, weight: weight) : .systemFont(ofSize: size, weight: weight)
  return UIFontMetrics(forTextStyle: style).scaledFont(for: base)
}

/// The desktop pill's lucide Mic and Bot glyphs, so both platforms share one mark per mode.
@MainActor
private enum Glyph {
  static let mic = draw { path in
    path.append(UIBezierPath(roundedRect: CGRect(x: 9, y: 2, width: 6, height: 13), cornerRadius: 3))
    path.move(to: CGPoint(x: 19, y: 10))
    path.addLine(to: CGPoint(x: 19, y: 12))
    path.addArc(withCenter: CGPoint(x: 12, y: 12), radius: 7, startAngle: 0, endAngle: .pi, clockwise: true)
    path.addLine(to: CGPoint(x: 5, y: 10))
    path.move(to: CGPoint(x: 12, y: 19))
    path.addLine(to: CGPoint(x: 12, y: 22))
  }

  static let bot = draw { path in
    path.move(to: CGPoint(x: 12, y: 8))
    path.addLine(to: CGPoint(x: 12, y: 4))
    path.addLine(to: CGPoint(x: 8, y: 4))
    path.append(UIBezierPath(roundedRect: CGRect(x: 4, y: 8, width: 16, height: 12), cornerRadius: 2))
    for (from, to) in [((2, 14), (4, 14)), ((20, 14), (22, 14)), ((15, 13), (15, 15)), ((9, 13), (9, 15))] {
      path.move(to: CGPoint(x: from.0, y: from.1))
      path.addLine(to: CGPoint(x: to.0, y: to.1))
    }
  }

  /// Strokes a 24-point lucide path at 22 points as a template image.
  private static func draw(_ build: (UIBezierPath) -> Void) -> UIImage {
    let size: CGFloat = 22
    let path = UIBezierPath()
    build(path)
    path.apply(CGAffineTransform(scaleX: size / 24, y: size / 24))
    path.lineWidth = 2 * size / 24
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    return UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
      UIColor.black.setStroke()
      path.stroke()
    }.withRenderingMode(.alwaysTemplate)
  }
}

/// Responds the moment a finger lands: a quick press-in, a softer settle on release.
private class PressControl: UIControl {
  var pressedScale: CGFloat = 0.96
  var restingColor: UIColor? { didSet { backgroundColor = restingColor } }
  var pressedColor: UIColor?
  /// Runs on VoiceOver or Switch Control activation, which may skip touch-down; delete keys act through this.
  var accessibilityAction: (() -> Void)?

  override func accessibilityActivate() -> Bool {
    guard let accessibilityAction else { return super.accessibilityActivate() }
    accessibilityAction()
    return true
  }

  override var isHighlighted: Bool {
    didSet {
      guard isHighlighted != oldValue else { return }
      let pressed = isHighlighted
      let scale = UIAccessibility.isReduceMotionEnabled ? 1 : pressedScale
      UIView.animate(springDuration: pressed ? 0.16 : 0.34, bounce: 0, initialSpringVelocity: 0, delay: 0,
        options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.transform = pressed ? CGAffineTransform(scaleX: scale, y: scale) : .identity
        self.backgroundColor = pressed ? (self.pressedColor ?? self.restingColor) : self.restingColor
      }
    }
  }
}

/// A home action, styled as its desktop recording pill.
private final class ActionRow: PressControl {
  let well = UIView()
  private let subtitleLabel = UILabel()

  var subtitle: String {
    get { subtitleLabel.text ?? "" }
    set {
      subtitleLabel.text = newValue
      accessibilityHint = newValue
    }
  }

  /// Unavailable rows stay tappable so a tap can say why.
  var isAvailable = true { didSet { alpha = isAvailable ? 1 : 0.45 } }

  init(mode: KeyboardSession.Mode) {
    super.init(frame: .zero)
    let agent = mode == .agent
    let accent = agent ? Palette.vermilion : Palette.blue
    pressedScale = 0.97
    restingColor = agent ? Palette.soot.mixed(with: Palette.vermilion, 0.07) : Palette.ash
    pressedColor = agent ? Palette.soot.mixed(with: Palette.vermilion, 0.13) : Palette.ashPressed
    layer.cornerRadius = agent ? 6 : 14
    layer.cornerCurve = .continuous
    layer.borderWidth = 1
    layer.borderColor = (agent ? Palette.vermilion.withAlphaComponent(0.45) : Palette.hairline).cgColor

    well.backgroundColor = accent.withAlphaComponent(agent ? 0.18 : 0.16)
    well.layer.cornerRadius = agent ? 3 : 10
    well.layer.cornerCurve = .continuous
    let glyph = UIImageView(image: agent ? Glyph.bot : Glyph.mic)
    glyph.tintColor = accent
    glyph.translatesAutoresizingMaskIntoConstraints = false
    well.addSubview(glyph)

    let title = UILabel()
    title.text = agent ? "Ask the agent" : "Dictate"
    title.font = scaledFont(16, .semibold, .headline)
    title.textColor = Palette.parchment
    subtitleLabel.font = scaledFont(12, .regular, .footnote)
    subtitleLabel.textColor = Palette.faded
    for label in [title, subtitleLabel] {
      label.adjustsFontForContentSizeCategory = true
      label.adjustsFontSizeToFitWidth = true
      label.minimumScaleFactor = 0.8
    }
    let text = UIStackView(arrangedSubviews: [title, subtitleLabel])
    text.axis = .vertical
    text.spacing = 1
    let content = UIStackView(arrangedSubviews: [well, text])
    content.spacing = 12
    content.alignment = .center
    content.isUserInteractionEnabled = false
    content.translatesAutoresizingMaskIntoConstraints = false
    addSubview(content)
    NSLayoutConstraint.activate([
      well.widthAnchor.constraint(equalToConstant: 40),
      well.heightAnchor.constraint(equalToConstant: 40),
      glyph.centerXAnchor.constraint(equalTo: well.centerXAnchor),
      glyph.centerYAnchor.constraint(equalTo: well.centerYAnchor),
      content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      content.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -12),
      content.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])

    isAccessibilityElement = true
    accessibilityTraits = .button
    accessibilityLabel = title.text
    subtitle = agent ? "One-off command · follow the Live Activity" : "Types at the cursor"
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// Live input level, newest in the centre and older readings rippling outward. Driven only by real levels from
/// the app while recording; between pushes nothing animates.
private final class LevelBars: UIView {
  private static let count = 21
  private static let barWidth: CGFloat = 3
  private static let step: CGFloat = 6
  private var history = [CGFloat](repeating: 0, count: count / 2 + 1)
  private let bars: [CALayer] = (0..<count).map { _ in CALayer() }

  var color = UIColor.white { didSet { for bar in bars { bar.backgroundColor = color.cgColor } } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    for bar in bars { layer.addSublayer(bar) }
    isAccessibilityElement = false
    isUserInteractionEnabled = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override var intrinsicContentSize: CGSize {
    CGSize(width: CGFloat(Self.count) * Self.step - (Self.step - Self.barWidth), height: 36)
  }

  func push(_ level: CGFloat) {
    history.removeLast()
    history.insert(min(max(level, 0), 1), at: 0)
    layoutBars(animated: true)
  }

  func settle() {
    guard history.contains(where: { $0 > 0 }) else { return }
    history = [CGFloat](repeating: 0, count: history.count)
    layoutBars(animated: true)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layoutBars(animated: false)
  }

  private func layoutBars(animated: Bool) {
    CATransaction.begin()
    CATransaction.setDisableActions(!animated || UIAccessibility.isReduceMotionEnabled)
    // About one level interval, so consecutive readings blend instead of stepping.
    CATransaction.setAnimationDuration(0.1)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeOut))
    let centre = Self.count / 2
    var x = (bounds.width - intrinsicContentSize.width) / 2
    for (index, bar) in bars.enumerated() {
      let distance = abs(index - centre)
      let taper = 1 - CGFloat(distance) / CGFloat(centre) * 0.45
      let height = max(Self.barWidth, history[distance] * taper * bounds.height)
      bar.frame = CGRect(x: x, y: (bounds.height - height) / 2, width: Self.barWidth, height: height)
      bar.cornerRadius = Self.barWidth / 2
      x += Self.step
    }
    CATransaction.commit()
  }
}
