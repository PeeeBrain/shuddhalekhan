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
  private let keyPreview = UILabel()
  private weak var previewKey: UIButton?
  private lazy var statusHeight = statusLabel.heightAnchor.constraint(equalToConstant: 0)
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
      keyboard.bottomAnchor.constraint(equalTo: view.bottomAnchor)
    ])
    // Below required so it never fights the system's own keyboard height constraint while appearing.
    let height = view.heightAnchor.constraint(equalToConstant: 316)
    height.priority = UILayoutPriority(rawValue: 999)
    height.isActive = true

    statusLabel.font = .preferredFont(forTextStyle: .footnote)
    statusLabel.adjustsFontForContentSizeCategory = true
    statusLabel.textColor = .secondaryLabel
    statusLabel.numberOfLines = 2
    // Always reserves two lines (see viewWillLayoutSubviews) so status changes never move the buttons or keys.
    statusHeight.constant = ceil(statusLabel.font.lineHeight * 2)
    statusHeight.isActive = true
    clockLabel.font = UIFontMetrics(forTextStyle: .footnote)
      .scaledFont(for: .monospacedDigitSystemFont(ofSize: 13, weight: .semibold))
    clockLabel.adjustsFontForContentSizeCategory = true
    clockLabel.textColor = .secondaryLabel
    clockLabel.setContentHuggingPriority(.required, for: .horizontal)
    clockLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    let statusRow = UIStackView(arrangedSubviews: [statusLabel, clockLabel])
    statusRow.spacing = 8
    statusRow.isLayoutMarginsRelativeArrangement = true
    statusRow.layoutMargins = UIEdgeInsets(top: 0, left: 6, bottom: 0, right: 6)
    statusRow.setContentHuggingPriority(.defaultHigh, for: .vertical)
    keyboard.addArrangedSubview(statusRow)

    // Filled configurations darken on touch down and dim when disabled, like system buttons.
    var dictateStyle = UIButton.Configuration.filled()
    dictateStyle.cornerStyle = .fixed
    dictateStyle.background.cornerRadius = 12
    dictateStyle.imagePadding = 8
    dictateStyle.baseForegroundColor = .white
    dictateStyle.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var attributes = attributes
      attributes.font = .preferredFont(forTextStyle: .headline)
      return attributes
    }
    dictateButton.configuration = dictateStyle
    dictateButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
    dictateButton.addTarget(self, action: #selector(dictateTapped), for: .touchUpInside)
    var cancelStyle = dictateStyle
    cancelStyle.image = UIImage(systemName: "xmark")
    cancelStyle.baseBackgroundColor = UIColor(white: 0.24, alpha: 1)
    cancelButton.configuration = cancelStyle
    cancelButton.accessibilityLabel = "Cancel dictation"
    cancelButton.widthAnchor.constraint(equalToConstant: 56).isActive = true
    cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    let dictationRow = UIStackView(arrangedSubviews: [dictateButton, cancelButton])
    dictationRow.spacing = 6
    dictationRow.setContentHuggingPriority(.defaultHigh, for: .vertical)
    keyboard.addArrangedSubview(dictationRow)

    // The key rows take the keyboard's spare height, split evenly, so no state change resizes them.
    keyRows.axis = .vertical
    keyRows.spacing = 8
    keyRows.distribution = .fillEqually
    keyboard.addArrangedSubview(keyRows)

    styleKey(shiftButton, function: true)
    shiftButton.setImage(UIImage(systemName: "shift"), for: .normal)
    shiftButton.accessibilityLabel = "Shift"
    shiftButton.widthAnchor.constraint(equalToConstant: 44).isActive = true
    shiftButton.addTarget(self, action: #selector(toggleShift), for: .touchUpInside)
    showKeyRows()
    render()

    // Decorative and last in the subview list, so it draws over the keys without catching taps or VoiceOver focus.
    keyPreview.isUserInteractionEnabled = false
    keyPreview.isAccessibilityElement = false
    keyPreview.accessibilityElementsHidden = true
    keyPreview.isHidden = true
    keyPreview.textAlignment = .center
    keyPreview.font = .systemFont(ofSize: 32)
    keyPreview.textColor = .white
    keyPreview.backgroundColor = UIColor(white: 0.33, alpha: 1)
    keyPreview.layer.cornerRadius = 8
    keyPreview.layer.masksToBounds = true
    view.addSubview(keyPreview)
  }

  override func viewWillLayoutSubviews() {
    super.viewWillLayoutSubviews()
    let twoLines = ceil(statusLabel.font.lineHeight * 2)
    if statusHeight.constant != twoLines { statusHeight.constant = twoLines }
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    log.notice("SpeechPerf keyboard stage=appear")
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
    hideKeyPreview()
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
      log.notice("SpeechPerf keyboard stage=inserted id=\(pendingId, privacy: .public)")
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
    log.notice("SpeechPerf keyboard stage=\(action.rawValue, privacy: .public) id=\(id, privacy: .public)")
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
    var style = dictateButton.configuration
    style?.title = title
    style?.image = UIImage(systemName: symbol)
    style?.baseBackgroundColor = background
    dictateButton.configuration = style
    dictateButton.accessibilityLabel = title
    dictateButton.isEnabled = phase != .transcribing
    // Dimmed rather than hidden, so the Dictate button keeps its width across states.
    cancelButton.isEnabled = phase != nil
    let text = message ?? defaultStatus(phase)
    if statusLabel.text != text {
      statusLabel.text = text
      UIAccessibility.post(notification: .announcement, argument: text)
    }
    tick()
  }

  private func defaultStatus(_ phase: KeyboardSession.State.Phase?) -> String {
    switch phase {
    case .recording?: return "Listening…"
    case .transcribing?: return "Transcribing on this iPhone…"
    default: return session == nil ? "No active keyboard session." : "Tap Dictate, speak, then tap Stop."
    }
  }

  private func tick() {
    guard let session else { clockLabel.text = nil; return }
    let remaining = max(0, Int((session.sessionEndsAt - KeyboardSession.nowMs()) / 1_000))
    var text = String(format: "%d:%02d", remaining / 60, remaining % 60)
    var label = "\(remaining / 60) minutes \(remaining % 60) seconds left in the keyboard session"
    if activePhase == .recording, let pendingSince {
      let elapsed = Int(Date().timeIntervalSince(pendingSince))
      text = String(format: "● %d:%02d", elapsed / 60, elapsed % 60)
      label = "Recording \(elapsed / 60) minutes \(elapsed % 60) seconds. " + label
    }
    clockLabel.text = text
    clockLabel.accessibilityLabel = label
  }

  // MARK: Keys

  private func showKeyRows() {
    hideKeyPreview()
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
      styleKey(nextKeyboardButton, function: true)
      nextKeyboardButton.setImage(UIImage(systemName: "globe"), for: .normal)
      nextKeyboardButton.accessibilityLabel = "Next keyboard"
      nextKeyboardButton.widthAnchor.constraint(equalToConstant: 44).isActive = true
      nextKeyboardButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
      nextKeyboardButton.addTarget(self, action: #selector(handleInputModeList(from:with:)), for: .allTouchEvents)
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
      button.addTarget(self, action: #selector(showKeyPreview(_:)), for: [.touchDown, .touchDragEnter])
      button.addTarget(self, action: #selector(releaseKeyPreview(_:)),
        for: [.touchUpInside, .touchUpOutside, .touchDragExit, .touchCancel])
      row.addArrangedSubview(button)
    }
    return row
  }

  private func letterEditRow() -> UIStackView {
    let row = UIStackView()
    row.axis = .horizontal
    row.spacing = 5

    shiftButton.accessibilityValue = isUppercase ? "Uppercase" : "Lowercase"
    shiftButton.isSelected = isUppercase
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
    styleKey(button, function: function)
    button.setTitle(title, for: .normal)
    button.accessibilityLabel = label
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 42).isActive = true
    if let width {
      button.widthAnchor.constraint(equalToConstant: width).isActive = true
    }
    button.addTarget(self, action: action, for: .touchUpInside)
    return button
  }

  /// Keys swap to the other key shade the moment a finger lands, like the system keyboard.
  /// Selected keys (shift on) are light with a dark glyph.
  private func styleKey(_ button: UIButton, function: Bool) {
    var style = UIButton.Configuration.plain()
    style.contentInsets = .zero
    style.background.cornerRadius = 6
    style.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var attributes = attributes
      attributes.font = .systemFont(ofSize: function ? 15 : 22)
      return attributes
    }
    button.configuration = style
    button.configurationUpdateHandler = { button in
      let shade: CGFloat = if button.isSelected { button.isHighlighted ? 0.65 : 0.85 }
        else if button.isHighlighted { function ? 0.33 : 0.2 }
        else { function ? 0.2 : 0.33 }
      var style = button.configuration
      style?.background.backgroundColor = UIColor(white: shade, alpha: 1)
      style?.baseForegroundColor = button.isSelected ? .black : .white
      button.configuration = style
    }
  }

  @objc private func insertInputKey(_ sender: UIButton) {
    guard let key = sender.accessibilityIdentifier else { return }
    textDocumentProxy.insertText(isSymbolsMode ? key : (isUppercase ? key : key.lowercased()))
    if isUppercase && !isSymbolsMode {
      isUppercase = false
      updateShift()
    }
  }

  /// Enlarged copy of a character key above the finger. A keyboard extension can't draw outside its own view,
  /// so the bubble is clamped inside it and overlaps the row (or dictation controls) above.
  private static func previewFrame(key: CGRect, bounds: CGRect) -> CGRect {
    let size = CGSize(width: min(key.width + 20, bounds.width), height: min(key.height + 14, bounds.height))
    let x = min(max(key.midX - size.width / 2, bounds.minX), bounds.maxX - size.width)
    let y = min(max(key.minY - size.height - 4, bounds.minY), bounds.maxY - size.height)
    return CGRect(origin: CGPoint(x: x, y: y), size: size)
  }

  @objc private func showKeyPreview(_ sender: UIButton) {
    previewKey = sender
    keyPreview.text = sender.title(for: .normal)
    keyPreview.frame = Self.previewFrame(key: sender.convert(sender.bounds, to: view), bounds: view.bounds)
    assert(view.bounds.contains(keyPreview.frame), "Key preview must stay inside the keyboard")
    keyPreview.isHidden = false
  }

  /// Only the key that owns the bubble hides it, so a lifting first finger doesn't clear a second key's preview.
  @objc private func releaseKeyPreview(_ sender: UIButton) {
    if sender === previewKey { hideKeyPreview() }
  }

  private func hideKeyPreview() {
    previewKey = nil
    keyPreview.isHidden = true
  }

  @objc private func toggleShift() {
    isUppercase.toggle()
    updateShift()
  }

  private func updateShift() {
    hideKeyPreview()
    shiftButton.isSelected = isUppercase
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
