import UIKit
import Network
import OSLog

/// Dictation keyboard. It never records: it asks the Shuddhalekhan app's active keyboard session to record,
/// then inserts that request's final transcript at the cursor. See KeyboardSessionProtocol.swift.
final class KeyboardViewController: UIInputViewController {
  private static let ackTimeout: TimeInterval = 3

  private let statusLabel = UILabel()
  private let clockLabel = UILabel()
  private let dictateButton = UIButton(type: .system)
  private let cancelButton = UIButton(type: .system)
  private let shiftButton = UIButton(type: .system)
  private let keyRows = UIStackView()
  private var isUppercase = false
  private var isSymbolsMode = false

  private var session: KeyboardSession.State?
  private var pendingId: String?
  private var pendingSince: Date?
  private var insertedIds = Set<String>()
  private var clock: Timer?
  private var channel: KeyboardSessionChannel?
  private var bridge: KeyboardSession.Bridge?
  private var receivedState = false
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "KeyboardBridge")

  override func viewDidLoad() {
    super.viewDidLoad()
    view.overrideUserInterfaceStyle = .dark
    view.backgroundColor = UIColor(white: 0.09, alpha: 1)

    let keyboard = UIStackView()
    keyboard.axis = .vertical
    keyboard.spacing = 8
    keyboard.isLayoutMarginsRelativeArrangement = true
    keyboard.layoutMargins = UIEdgeInsets(top: 8, left: 4, bottom: 6, right: 4)
    view.addSubview(keyboard)
    keyboard.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      keyboard.topAnchor.constraint(equalTo: view.topAnchor),
      keyboard.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      keyboard.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      keyboard.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      view.heightAnchor.constraint(equalToConstant: 316)
    ])

    statusLabel.font = .preferredFont(forTextStyle: .footnote)
    statusLabel.adjustsFontForContentSizeCategory = true
    statusLabel.textColor = .secondaryLabel
    statusLabel.numberOfLines = 2
    clockLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
    clockLabel.textColor = .secondaryLabel
    clockLabel.setContentHuggingPriority(.required, for: .horizontal)
    clockLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    let statusRow = UIStackView(arrangedSubviews: [statusLabel, clockLabel])
    statusRow.spacing = 8
    statusRow.isLayoutMarginsRelativeArrangement = true
    statusRow.layoutMargins = UIEdgeInsets(top: 0, left: 6, bottom: 0, right: 6)
    keyboard.addArrangedSubview(statusRow)

    dictateButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    dictateButton.titleLabel?.adjustsFontForContentSizeCategory = true
    dictateButton.tintColor = .white
    dictateButton.layer.cornerRadius = 12
    dictateButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
    dictateButton.addTarget(self, action: #selector(dictateTapped), for: .touchUpInside)
    cancelButton.setImage(UIImage(systemName: "xmark"), for: .normal)
    cancelButton.tintColor = .white
    cancelButton.backgroundColor = UIColor(white: 0.24, alpha: 1)
    cancelButton.layer.cornerRadius = 12
    cancelButton.accessibilityLabel = "Cancel dictation"
    cancelButton.widthAnchor.constraint(equalToConstant: 56).isActive = true
    cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    let dictationRow = UIStackView(arrangedSubviews: [dictateButton, cancelButton])
    dictationRow.spacing = 6
    keyboard.addArrangedSubview(dictationRow)

    keyRows.axis = .vertical
    keyRows.spacing = 8
    keyboard.addArrangedSubview(keyRows)

    shiftButton.setImage(UIImage(systemName: "shift"), for: .normal)
    shiftButton.accessibilityLabel = "Shift"
    shiftButton.widthAnchor.constraint(equalToConstant: 44).isActive = true
    shiftButton.addTarget(self, action: #selector(toggleShift), for: .touchUpInside)
    styleKey(shiftButton, function: true, selected: false)
    showKeyRows()
    render()
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    // Updates only the countdown text, once a second, while the keyboard is on screen.
    clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
    refresh()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    // Closing the authenticated connection cancels its utterance on the app side.
    if let pendingId { send(.cancel, id: pendingId) }
    pendingId = nil
    clock?.invalidate()
    clock = nil
    disconnect()
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
      render(message: "Open Shuddhalekhan and tap Start keyboard session.")
      return
    }
    self.bridge = bridge
    receivedState = false
    let link = KeyboardSessionChannel(NWConnection(host: "127.0.0.1", port: port, using: .tcp),
      maxBytes: KeyboardSession.maxTextBytes * 7)
    channel = link
    link.onOpen = { [weak self, weak link] in
      guard let self, let link, self.channel === link else { return }
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
      if !endedNormally {
        self.log.error("KeyboardBridge connection lost")
        self.render(message: "Keyboard connection lost. Open Shuddhalekhan and start a new session.")
      }
    }
    render(message: "Connecting to Shuddhalekhan...")
    link.start()
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.ackTimeout) { [weak self, weak link] in
      guard let self, let link, self.channel === link, !self.receivedState else { return }
      link.close()
    }
  }

  private func receive(_ state: KeyboardSession.State) {
    log.notice("KeyboardBridge received phase \(state.phase.rawValue, privacy: .public)")
    session = state.isLive(now: KeyboardSession.nowMs()) || state.isBusy ? state : nil
    guard let pendingId, state.requestId == pendingId else {
      if session == nil { pendingId = nil }
      render(message: session == nil ? state.error.map { "Session ended. \($0)" } : nil)
      return
    }
    if let text = KeyboardSession.insertion(state, pendingId: pendingId, inserted: insertedIds) {
      insertedIds.insert(pendingId)
      self.pendingId = nil
      textDocumentProxy.insertText(text)
      render(message: "Inserted.")
      return
    }
    switch state.phase {
    case .failed:
      self.pendingId = nil
      render(message: state.error ?? "Dictation failed. Try again.")
    case .cancelled, .done, .idle:
      self.pendingId = nil
      render()
    case .recording, .transcribing:
      render()
    }
  }

  @objc private func dictateTapped() {
    guard hasFullAccess else { return refresh() }
    guard let session else {
      refresh()
      return
    }
    if let pendingId {
      if session.requestId == pendingId, session.phase == .recording { send(.stop, id: pendingId) }
      return
    }
    let id = UUID().uuidString
    pendingId = id
    pendingSince = Date()
    guard send(.start, id: id) else { pendingId = nil; return }
    render(message: "Starting…")
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.ackTimeout) { [weak self] in
      guard let self, self.pendingId == id, self.session?.requestId != id else { return }
      // A start the app reads late would otherwise record for nobody until the utterance cap.
      self.send(.cancel, id: id)
      self.pendingId = nil
      self.render(message: "Shuddhalekhan didn't respond. Open the app to check the session.")
    }
  }

  @objc private func cancelTapped() {
    guard let pendingId else { return }
    send(.cancel, id: pendingId)
  }

  @discardableResult
  private func send(_ action: KeyboardSession.Command.Action, id: String) -> Bool {
    guard let channel, let bridge else {
      session = nil
      render(message: "Keyboard connection unavailable. Open Shuddhalekhan and start a new session.")
      return false
    }
    channel.send(KeyboardSession.Request(token: bridge.token,
      command: .init(id: id, action: action, sentAt: KeyboardSession.nowMs())))
    return true
  }

  private var activePhase: KeyboardSession.State.Phase? {
    guard let pendingId, let session, session.requestId == pendingId, session.isBusy else { return nil }
    return session.phase
  }

  private func render(message: String? = nil) {
    let phase = activePhase
    let (title, symbol, background): (String, String, UIColor) = switch (session, phase) {
    case (nil, _): ("Start a session in Shuddhalekhan", "mic.slash", UIColor(white: 0.24, alpha: 1))
    case (_, .recording?): ("Stop and insert", "stop.fill", .systemRed)
    case (_, .transcribing?): ("Transcribing…", "waveform", UIColor(white: 0.24, alpha: 1))
    default: (pendingId == nil ? "Dictate" : "Starting…", "mic.fill", .systemBlue)
    }
    dictateButton.setTitle("  " + title, for: .normal)
    dictateButton.setImage(UIImage(systemName: symbol), for: .normal)
    dictateButton.backgroundColor = background
    dictateButton.accessibilityLabel = title
    dictateButton.isEnabled = phase != .transcribing
    cancelButton.isHidden = phase == nil
    let text = message ?? defaultStatus(phase)
    if statusLabel.text != text {
      statusLabel.text = text
      UIAccessibility.post(notification: .announcement, argument: text)
    }
    tick()
  }

  private func defaultStatus(_ phase: KeyboardSession.State.Phase?) -> String {
    switch phase {
    case .recording?: return "Listening. Tap Stop to insert at the cursor."
    case .transcribing?: return "Transcribing on this iPhone…"
    default: return session == nil ? "No active keyboard session." : "Tap Dictate, speak, then tap Stop."
    }
  }

  private func tick() {
    guard let session else { clockLabel.text = nil; return }
    let remaining = max(0, Int((session.sessionEndsAt - KeyboardSession.nowMs()) / 1_000))
    var text = String(format: "Session %d:%02d", remaining / 60, remaining % 60)
    if activePhase == .recording, let pendingSince {
      let elapsed = Int(Date().timeIntervalSince(pendingSince))
      text = String(format: "● %d:%02d · ", elapsed / 60, elapsed % 60) + text
    }
    clockLabel.text = text
    clockLabel.accessibilityLabel = "\(remaining / 60) minutes \(remaining % 60) seconds left in the keyboard session"
  }

  // MARK: Keys

  private func showKeyRows() {
    for row in keyRows.arrangedSubviews {
      keyRows.removeArrangedSubview(row)
      row.removeFromSuperview()
    }

    if isSymbolsMode {
      keyRows.addArrangedSubview(keyRow("1234567890"))
      keyRows.addArrangedSubview(keyRow("-/:;()$&@\""))
      keyRows.addArrangedSubview(symbolEditRow())
    } else {
      keyRows.addArrangedSubview(keyRow("QWERTYUIOP", letters: true))
      keyRows.addArrangedSubview(keyRow("ASDFGHJKL", letters: true, horizontalInset: 16))
      keyRows.addArrangedSubview(letterEditRow())
    }

    let bottomRow = UIStackView()
    bottomRow.axis = .horizontal
    bottomRow.spacing = 5
    bottomRow.addArrangedSubview(makeKey(isSymbolsMode ? "ABC" : "123", label: isSymbolsMode ? "Letters" : "Numbers and symbols", width: 52, function: true, action: #selector(toggleSymbols)))

    if needsInputModeSwitchKey {
      let nextKeyboardButton = UIButton(type: .system)
      nextKeyboardButton.setImage(UIImage(systemName: "globe"), for: .normal)
      nextKeyboardButton.accessibilityLabel = "Next keyboard"
      nextKeyboardButton.widthAnchor.constraint(equalToConstant: 44).isActive = true
      nextKeyboardButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
      nextKeyboardButton.addTarget(self, action: #selector(handleInputModeList(from:with:)), for: .allTouchEvents)
      styleKey(nextKeyboardButton, function: true, selected: false)
      bottomRow.addArrangedSubview(nextKeyboardButton)
    }

    let spaceButton = makeKey("space", label: "Space", width: nil, action: #selector(insertSpace))
    spaceButton.setContentHuggingPriority(.defaultLow, for: .horizontal)
    spaceButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    bottomRow.addArrangedSubview(spaceButton)
    bottomRow.addArrangedSubview(makeKey("return", label: "Return", width: 80, function: true, action: #selector(insertReturn)))
    keyRows.addArrangedSubview(bottomRow)
  }

  private func keyRow(_ keys: String, letters: Bool = false, horizontalInset: CGFloat = 0) -> UIStackView {
    let row = UIStackView()
    row.axis = .horizontal
    row.spacing = 5
    row.distribution = .fillEqually
    row.layoutMargins = UIEdgeInsets(top: 0, left: horizontalInset, bottom: 0, right: horizontalInset)
    row.isLayoutMarginsRelativeArrangement = true

    for character in keys {
      let key = String(character)
      let title = letters && !isUppercase ? key.lowercased() : key
      let button = makeKey(title, label: title, width: nil, action: #selector(insertInputKey(_:)))
      button.accessibilityIdentifier = key
      row.addArrangedSubview(button)
    }
    return row
  }

  private func letterEditRow() -> UIStackView {
    let row = UIStackView()
    row.axis = .horizontal
    row.spacing = 5

    shiftButton.accessibilityValue = isUppercase ? "Uppercase" : "Lowercase"
    styleKey(shiftButton, function: true, selected: isUppercase)
    row.addArrangedSubview(shiftButton)

    let letters = keyRow("ZXCVBNM", letters: true)
    letters.setContentHuggingPriority(.defaultLow, for: .horizontal)
    letters.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    row.addArrangedSubview(letters)
    row.addArrangedSubview(deleteKey())
    return row
  }

  private func symbolEditRow() -> UIStackView {
    let row = UIStackView()
    row.axis = .horizontal
    row.spacing = 5

    let symbols = keyRow(".,?!'")
    symbols.setContentHuggingPriority(.defaultLow, for: .horizontal)
    symbols.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    row.addArrangedSubview(symbols)
    row.addArrangedSubview(deleteKey())
    return row
  }

  private func deleteKey() -> UIButton {
    let button = makeKey("", label: "Delete", width: 44, function: true, action: #selector(deleteBackward))
    button.setImage(UIImage(systemName: "delete.left"), for: .normal)
    return button
  }

  private func makeKey(_ title: String, label: String, width: CGFloat?, function: Bool = false, action: Selector) -> UIButton {
    let button = UIButton(type: .system)
    button.setTitle(title, for: .normal)
    button.titleLabel?.font = function ? .systemFont(ofSize: 15) : .systemFont(ofSize: 22)
    button.accessibilityLabel = label
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 42).isActive = true
    if let width {
      button.widthAnchor.constraint(equalToConstant: width).isActive = true
    }
    button.addTarget(self, action: action, for: .touchUpInside)
    styleKey(button, function: function, selected: false)
    return button
  }

  private func styleKey(_ button: UIButton, function: Bool, selected: Bool) {
    button.backgroundColor = selected ? UIColor(white: 0.85, alpha: 1) : UIColor(white: function ? 0.2 : 0.33, alpha: 1)
    button.tintColor = selected ? .black : .white
    button.setTitleColor(.white, for: .normal)
    button.layer.cornerRadius = 6
    button.accessibilityTraits = selected ? [.button, .selected] : .button
  }

  @objc private func insertInputKey(_ sender: UIButton) {
    guard let key = sender.accessibilityIdentifier else { return }
    textDocumentProxy.insertText(isSymbolsMode ? key : (isUppercase ? key : key.lowercased()))
    if isUppercase && !isSymbolsMode {
      isUppercase = false
      updateShift()
    }
  }

  @objc private func toggleShift() {
    isUppercase.toggle()
    updateShift()
  }

  private func updateShift() {
    styleKey(shiftButton, function: true, selected: isUppercase)
    shiftButton.accessibilityValue = isUppercase ? "Uppercase" : "Lowercase"
    refreshLetterKeys(in: keyRows)
  }

  private func refreshLetterKeys(in view: UIView) {
    for subview in view.subviews {
      if let button = subview as? UIButton, let key = button.accessibilityIdentifier {
        let title = isUppercase ? key : key.lowercased()
        button.setTitle(title, for: .normal)
        button.accessibilityLabel = title
      }
      refreshLetterKeys(in: subview)
    }
  }

  @objc private func toggleSymbols() {
    isSymbolsMode.toggle()
    isUppercase = false
    showKeyRows()
  }

  @objc private func insertSpace() {
    textDocumentProxy.insertText(" ")
  }

  @objc private func insertReturn() {
    textDocumentProxy.insertText("\n")
  }

  @objc private func deleteBackward() {
    textDocumentProxy.deleteBackward()
  }
}
