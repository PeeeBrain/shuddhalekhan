// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXShared/FullKeyboard/HexKeyViews.swift at f38e9fc.
// See Typing/NOTICE.md.

import UIKit

/// A voice key in the strip (Shuddhalekhan): Dictation at its trailing end, Agent Mode at its leading
/// end. A tap starts that request, a hold records until released (push to talk), and sliding from
/// the Dictation key opens the style menu (`VoiceKeyGesture`).
@MainActor
final class VoiceKeyControl: UIControl {
    var palette = FullKeyboardPalette(isDark: false) { didSet { if palette != oldValue { setNeedsDisplay() } } }
    /// Sits in the suggestion strip instead of the bottom row (prototype).
    var inStrip = false { didSet { if inStrip != oldValue { setNeedsDisplay() } } }
    /// Which request the key starts: its mark, colour and spoken name.
    var mode = KeyboardSession.Mode.dictate { didSet { if mode != oldValue { setNeedsDisplay(); updateAccessibility() } } }
    var cornerRadius: CGFloat = FullKeyboardPalette.cornerRadius { didSet { if cornerRadius != oldValue { setNeedsDisplay() } } }
    /// The drawn keycap inside the control's (larger) touch target.
    var keycapFrame: CGRect = .zero { didSet { if keycapFrame != oldValue { setNeedsDisplay() } } }
    /// In the strip, the suggestions' line in this view's coordinates
    /// (`KeyboardMetrics.stripTextCenter`): the mark centres on it, beside the words.
    var markCenterY: CGFloat? { didSet { if markCenterY != oldValue { setNeedsDisplay() } } }

    /// The finger landed on the key, with when (wall clock, from the touch's own timestamp).
    var onPress: ((TimeInterval) -> Void)?
    /// The press became a slide (the menu) or was cancelled before it was a tap or a hold.
    var onPressAbandoned: (() -> Void)?
    /// A tap or still hold: start the key's request.
    var onHold: (() -> Void)?
    /// The finger lifted after a still hold: push to talk's finish.
    var onHoldRelease: (() -> Void)?
    /// Points are in this control's coordinates.
    var onMenuOpen: ((CGPoint) -> Void)?
    var onMenuDrag: ((CGPoint) -> Void)?
    var onMenuRelease: ((CGPoint) -> Void)?

    private var gesture = VoiceKeyGesture()
    private var holdWork: DispatchWorkItem?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityTraits = .button
        updateAccessibility()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isHighlighted: Bool {
        didSet { if isHighlighted != oldValue { setNeedsDisplay() } }
    }

    private func updateAccessibility() {
        let agent = mode == .agent
        accessibilityLabel = agent ? "Ask the agent" : "Dictate"
        accessibilityHint = agent ? "Tap to speak a command, hold to talk" : "Tap to dictate, hold to talk, slide for styles"
        accessibilityCustomActions = agent ? [] : [
            UIAccessibilityCustomAction(name: "Dictation styles") { [weak self] _ in
                guard let self else { return false }
                self.onMenuOpen?(CGPoint(x: self.bounds.midX, y: self.bounds.midY))
                return true
            },
        ]
    }

    override func accessibilityActivate() -> Bool {
        onHold?()
        return true
    }

    override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        gesture.touchDown(at: touch.location(in: self))
        isHighlighted = true
        holdWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.holdElapsed() }
        holdWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + VoiceKeyGesture.holdDuration, execute: work)
        onPress?(Date().timeIntervalSince1970 - max(0, ProcessInfo.processInfo.systemUptime - touch.timestamp))
        return true
    }

    override func continueTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        let point = touch.location(in: self)
        switch gesture.touchMoved(to: point) {
        case .openMenu:
            stopTimer()
            isHighlighted = false
            onPressAbandoned?()
            onMenuOpen?(point)
        case .dragMenu:
            onMenuDrag?(point)
        default:
            break
        }
        return true
    }

    override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
        stopTimer()
        isHighlighted = false
        switch gesture.touchUp() {
        case .releaseMenu:
            if let touch { onMenuRelease?(touch.location(in: self)) }
        case .tap:
            onHold?()
        case .release:
            onHoldRelease?()
        default:
            break
        }
    }

    override func cancelTracking(with event: UIEvent?) {
        stopTimer()
        isHighlighted = false
        if gesture.cancel() == .abandon {
            onPressAbandoned?()
        }
    }

    private func holdElapsed() {
        holdWork = nil
        guard gesture.holdElapsed() == .hold else { return }
        isHighlighted = false
        onHold?()
    }

    private func stopTimer() {
        holdWork?.cancel()
        holdWork = nil
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let cap = keycapFrame == .zero ? bounds : keycapFrame
        // In the strip the mark sits on the suggestions' line, as tall as fits evenly around it
        // there (19 pt, or less where the line leaves less room), and so does its pressed chip.
        let markMidY = inStrip ? (markCenterY ?? cap.midY) : cap.midY
        let room = inStrip ? 2 * min(markMidY - cap.minY, cap.maxY - markMidY) : cap.height
        if !inStrip {
            context.fillKeycap(
                cap,
                fill: isHighlighted ? palette.keyPressedFill : palette.keyFill,
                shadow: palette.keyShadow,
                radius: cornerRadius
            )
        } else if isHighlighted {
            // In the strip the chip is on iOS's glass, not a key: the system's pressed grey.
            palette.systemPressedFill.setFill()
            let chip = CGRect(x: cap.minX, y: markMidY - room / 2, width: cap.width, height: room)
            UIBezierPath(roundedRect: chip, cornerRadius: room / 2).fill()
        }
        let markSize: CGFloat = inStrip ? min(19, room) : min(19, cap.height * 0.56)
        let markRect = CGRect(x: cap.midX - markSize / 2, y: markMidY - markSize / 2, width: markSize, height: markSize)
        let agent = mode == .agent
        let mark = agent ? VoiceMarks.bot : VoiceMarks.mic
        mark.withTintColor(agent ? VoiceMarks.vermilion : VoiceMarks.blue, renderingMode: .alwaysOriginal).draw(in: markRect)
    }
}

/// Launch arguments for the snapshot stage's motion scenes (`ios/scripts/motion-capture.sh`):
/// `--motion-slow 4` plays the strip at a quarter speed, `--motion-trace` writes per-frame
/// samples, and `--reduce-motion` plays it as Reduce Motion would.
enum MotionDebug {
    nonisolated static let slow: Double = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "--motion-slow"), i + 1 < args.count else { return 1 }
        return max(1, Double(args[i + 1]) ?? 1)
    }()
    nonisolated static let tracing = ProcessInfo.processInfo.arguments.contains("--motion-trace")
    nonisolated static let reduceMotion = ProcessInfo.processInfo.arguments.contains("--reduce-motion")
}

/// The recording strip's one spring family (Kit's motion tokens, no bounce): the bar, its
/// dots, ✕ and ✓, and the spinner all move on these, so nothing in the strip runs on its own clock.
enum StripMotion {
    /// Things arriving: ✕ and ✓, the Dictation key coming back, the spinner, the dots cooling.
    static let settle: TimeInterval = 0.3
    /// Things leaving, a fifth quicker.
    static let settleExit: TimeInterval = 0.24
    /// The soft edge the dots come out of the Dictation key behind, across the bar, and home again.
    static let grow: TimeInterval = 0.4
    static let shrink: TimeInterval = 0.32
    /// ✓'s mark handing its spot to the spinner.
    static let markExit: TimeInterval = 0.15
    /// Reduce Motion: a fade and nothing else.
    static let reducedFade: TimeInterval = 0.18
    /// ✕, ✓ and the Dictation key start this much smaller and grow into place as they fade in.
    static let controlScale: CGFloat = 0.86

    @MainActor static var reduced: Bool { UIAccessibility.isReduceMotionEnabled || MotionDebug.reduceMotion }

    /// A no-bounce spring. Durations stretch with `--motion-slow` through the window's layer
    /// speed; UIKit counts delays in real time, so those are stretched here. `fresh`: the values
    /// were only just set (nothing on screen yet), so the spring starts from them, not from what
    /// the layer last showed.
    @MainActor static func animate(
        _ duration: TimeInterval,
        delay: TimeInterval = 0,
        fresh: Bool = false,
        _ changes: @escaping @MainActor @Sendable () -> Void,
        completion: (@MainActor @Sendable (Bool) -> Void)? = nil
    ) {
        UIView.animate(
            springDuration: duration, bounce: 0, initialSpringVelocity: 0, delay: delay * MotionDebug.slow,
            options: fresh ? [.allowUserInteraction] : [.beginFromCurrentState, .allowUserInteraction],
            animations: changes, completion: completion
        )
    }
}

/// While recording, this replaces the suggestion strip only, so the keys stay put: a well of live
/// level dots (Shuddhalekhan's, not the keyboard's Metal scope) that takes the rest of the strip, then ✕ and
/// Done, ✓ where the voice key was. With the key on the left it mirrors: ✓, ✕, then the well.
@MainActor
final class VoiceRecordingPanel: UIView {
    var palette = FullKeyboardPalette(isDark: false) { didSet { if palette != oldValue { applyPalette() } } }
    var onDone: (() -> Void)?
    var onCancel: (() -> Void)?

    private let levels = LevelDots()
    private let well = UIView()
    private let cancelButton = PanelKeyButton()
    private let doneButton = PanelKeyButton()
    private let doneSpinner = UIActivityIndicatorView(style: .medium)
    private var currentPhase: KeyboardViewModel.StagePhase?
    private var showsSpinner = false
    /// Width of one modifier key, so ✕ lines up with 123 + space's start.
    var sideKeyWidth: CGFloat = 50 { didSet { setNeedsLayout() } }
    var horizontalInset: CGFloat = 0 { didSet { setNeedsLayout() } }
    var metrics = KeyboardMetrics.portrait { didSet { setNeedsLayout() } }
    /// The voice key sits on the left: ✓ and ✕ lead.
    var voiceKeyOnLeading = false { didSet { if voiceKeyOnLeading != oldValue { setNeedsLayout() } } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        well.layer.cornerRadius = 20
        well.layer.cornerCurve = .continuous
        well.clipsToBounds = true
        well.addSubview(levels)

        cancelButton.symbol = "xmark"
        cancelButton.accessibilityLabel = "Cancel"
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        doneButton.symbol = "checkmark"
        doneButton.isPrimary = true
        doneButton.accessibilityLabel = "Done"
        doneButton.addTarget(self, action: #selector(done), for: .touchUpInside)

        doneSpinner.hidesWhenStopped = true
        doneSpinner.isUserInteractionEnabled = false
        for view in [well, cancelButton, doneButton, doneSpinner] {
            addSubview(view)
        }
        applyPalette()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func tearDown() {
        levels.settle()
    }

    /// One reading from the session while recording, 0–1, about 15 a second.
    func push(level: CGFloat) {
        levels.push(level)
    }

    func update(phase: KeyboardViewModel.StagePhase, mode: KeyboardSession.Mode) {
        let wasShowingSpinner = showsSpinner
        let firstUpdate = currentPhase == nil
        currentPhase = phase
        showsSpinner = phase == .starting || phase == .transcribing
        levels.color = mode == .agent ? VoiceMarks.vermilion : VoiceMarks.blue
        levels.square = mode == .agent
        if phase != .recording { levels.settle() }
        // While starting and while transcribing, ✓'s spot shows the spinner so there's one place
        // to look and no checkmark before the microphone is live, while ✕ still cancels.
        doneButton.isPrimary = true
        doneButton.isEnabled = !showsSpinner
        doneButton.accessibilityLabel = switch phase {
        case .starting: "Starting"
        case .transcribing: "Transcribing"
        default: mode == .agent ? "Stop and send to the agent" : "Stop and insert"
        }
        if firstUpdate {
            doneButton.symbol = showsSpinner ? nil : "checkmark"
            if showsSpinner {
                doneSpinner.alpha = 1
                doneSpinner.transform = .identity
                doneSpinner.startAnimating()
            } else {
                doneSpinner.alpha = 0
                doneSpinner.stopAnimating()
            }
        } else if showsSpinner != wasShowingSpinner {
            swapDone(toSpinner: showsSpinner)
        } else {
            doneButton.symbol = showsSpinner ? nil : "checkmark"
        }
    }

    /// ✕ and ✓ at rest (shown), or gone: ✓ a little smaller in the voice key's spot, and ✕ tucked
    /// under it, so ✕ slides out from ✓ as it comes. With Reduce Motion they only fade.
    func setControls(shown: Bool) {
        let moves = !StripMotion.reduced
        let s = StripMotion.controlScale
        let small = CGAffineTransform(scaleX: s, y: s)
        doneButton.alpha = shown ? 1 : 0
        cancelButton.alpha = shown ? 1 : 0
        doneButton.transform = shown || !moves ? .identity : small
        let tuck = doneButton.center.x - cancelButton.center.x
        cancelButton.transform = shown || !moves ? .identity : CGAffineTransform(translationX: tuck, y: 0).scaledBy(x: s, y: s)
        // The spinner in ✓'s spot leaves with it, into the voice key's spot.
        doneSpinner.alpha = shown && showsSpinner ? 1 : 0
        doneSpinner.transform = shown || !moves ? .identity : small
    }

    /// The well's frame in the panel: where the dots are.
    var wellFrame: CGRect { well.frame }

    /// The dots' side of the soft edge they come out of the voice key behind.
    var dotsMask: StripRevealMask? {
        get { well.mask as? StripRevealMask }
        set { well.mask = newValue }
    }

    /// ✓ hands its spot to the spinner (and back): the mark fades and shrinks a little as the
    /// spinner grows in, so the button never stands empty.
    private func swapDone(toSpinner: Bool) {
        let animated = window != nil
        let moves = animated && !StripMotion.reduced
        let small = CGAffineTransform(scaleX: 0.6, y: 0.6)
        if toSpinner {
            doneSpinner.alpha = 0
            doneSpinner.transform = moves ? small : .identity
            doneSpinner.startAnimating()
        }
        let changes = {
            self.doneSpinner.alpha = toSpinner ? 1 : 0
            self.doneSpinner.transform = toSpinner || !moves ? .identity : small
        }
        guard animated else {
            doneButton.symbol = toSpinner ? nil : "checkmark"
            changes()
            if !toSpinner { doneSpinner.stopAnimating() }
            return
        }
        UIView.transition(
            with: doneButton,
            duration: toSpinner ? StripMotion.markExit : StripMotion.settle,
            options: [.transitionCrossDissolve, .allowUserInteraction, .beginFromCurrentState]
        ) {
            self.doneButton.symbol = toSpinner ? nil : "checkmark"
        }
        UIView.animate(
            springDuration: StripMotion.settle, bounce: 0, initialSpringVelocity: 0,
            delay: (toSpinner ? 0.06 : 0) * MotionDebug.slow,
            options: [.beginFromCurrentState, .allowUserInteraction], animations: changes
        ) { _ in
            if !toSpinner, !self.showsSpinner { self.doneSpinner.stopAnimating() }
        }
    }

    private func applyPalette() {
        cancelButton.palette = palette
        doneButton.palette = palette
        // On the Done key, in a key's label colour.
        doneSpinner.color = palette.keyText
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let innerLeft = horizontalInset + metrics.side
        let innerRight = bounds.width - horizontalInset - metrics.side
        // The strip's pill height, as far below its top as its pills are (on the words' line).
        let rowH = metrics.stripPillHeight
        let rowY = metrics.stripInset

        doneButton.cornerRadius = rowH / 2
        cancelButton.cornerRadius = rowH / 2
        // Bounds and centre, not frames: ✕ and ✓ may be mid-scale as they come and go.
        let doneRect: CGRect
        let cancelRect: CGRect
        if voiceKeyOnLeading {
            doneRect = CGRect(x: innerLeft, y: rowY, width: rowH, height: rowH)
            cancelRect = CGRect(x: doneRect.maxX + 6, y: rowY, width: rowH, height: rowH)
        } else {
            doneRect = CGRect(x: innerRight - rowH, y: rowY, width: rowH, height: rowH)
            cancelRect = CGRect(x: doneRect.minX - 6 - rowH, y: rowY, width: rowH, height: rowH)
        }
        for (button, rect) in [(doneButton, doneRect), (cancelButton, cancelRect)] {
            button.bounds = CGRect(origin: .zero, size: rect.size)
            button.center = CGPoint(x: rect.midX, y: rect.midY)
        }
        doneSpinner.center = CGPoint(x: doneRect.midX, y: doneRect.midY)

        let wellLeft = voiceKeyOnLeading ? cancelRect.maxX + 6 : innerLeft
        let wellRight = voiceKeyOnLeading ? innerRight : cancelRect.minX - 6
        well.frame = CGRect(x: wellLeft, y: rowY, width: max(24, wellRight - wellLeft), height: rowH)
        levels.frame = well.bounds
    }

    @objc private func done() { onDone?() }
    @objc private func cancel() { onCancel?() }
}

/// A keycap-styled button for the recording panel.
@MainActor
final class PanelKeyButton: UIControl {
    var palette = FullKeyboardPalette(isDark: false) { didSet { setNeedsDisplay() } }
    var title: String? { didSet { setNeedsDisplay() } }
    var symbol: String? { didSet { setNeedsDisplay() } }
    var isPrimary = false { didSet { setNeedsDisplay() } }
    var cornerRadius: CGFloat = FullKeyboardPalette.cornerRadius { didSet { setNeedsDisplay() } }
    /// Draws its title and symbol as the letter keys' 123 and delete do (the emoji panel's
    /// ABC and delete), not the recording panel's bolder ones.
    var drawsLikeKeys = false { didSet { setNeedsDisplay() } }
    /// Only the title or symbol, with a keycap only while pressed (the emoji panel's ABC and
    /// delete, which the system emoji keyboard draws without keys).
    var isPlain = false { didSet { setNeedsDisplay() } }
    /// How far past its edges a touch still counts as on the key (the emoji panel's bar).
    var hitOutsets: UIEdgeInsets = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityTraits = .button
        addTarget(self, action: #selector(redraw), for: [.touchDown, .touchDragEnter, .touchDragExit, .touchCancel, .touchUpInside, .touchUpOutside])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isEnabled: Bool { didSet { setNeedsDisplay() } }
    @objc private func redraw() { setNeedsDisplay() }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.inset(by: UIEdgeInsets(top: -hitOutsets.top, left: -hitOutsets.left, bottom: -hitOutsets.bottom, right: -hitOutsets.right)).contains(point)
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        if isHighlighted {
            // A plain one (the emoji panel's ABC and delete) is on the glass, not a key.
            context.fillKeycap(bounds, fill: isPlain ? palette.systemPressedFill : palette.keyPressedFill, radius: cornerRadius)
        } else if !isPlain {
            context.fillKeycap(bounds, fill: isPrimary ? palette.keyFill : palette.functionFill, radius: cornerRadius)
        }
        // A label on a key's own fill takes the keys' label colour; on the glass, or the
        // secondary fill over it, the glass's ink.
        let onKey = !isPlain && (isHighlighted || isPrimary)
        let ink = isEnabled
            ? (onKey ? palette.keyText : palette.textBase)
            : (onKey ? palette.keyTextMuted : palette.textMuted)
        if let symbol {
            let config = drawsLikeKeys
                ? UIImage.SymbolConfiguration(pointSize: bounds.height < 34 ? 16 : 18, weight: .regular)
                : UIImage.SymbolConfiguration(pointSize: 16.5, weight: .medium)
            if let image = UIImage(systemName: symbol, withConfiguration: config)?
                .withTintColor(ink, renderingMode: .alwaysOriginal) {
                image.draw(at: CGPoint(x: bounds.midX - image.size.width / 2, y: bounds.midY - image.size.height / 2))
            }
        } else if let title {
            let font: UIFont = drawsLikeKeys
                ? .systemFont(ofSize: bounds.height < 34 ? 14.5 : 15.5)
                : .systemFont(ofSize: 16.5, weight: .semibold)
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: ink,
            ]
            let size = (title as NSString).size(withAttributes: attributes)
            (title as NSString).draw(
                at: CGPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2),
                withAttributes: attributes
            )
        }
    }
}

/// Sliding from the Dictation key (or VoiceOver's Dictation styles): the keyboard session's
/// dictation styles. Picking one asks the app to switch (`KeyboardSession.Command.Action.setStyle`).
@MainActor
final class DictationStyleMenuView: UIView {
    var palette = FullKeyboardPalette(isDark: false) { didSet { rebuild() } }
    var style: DictationStyle? { didSet { if style != oldValue { rebuild() } } }
    var onStyle: ((DictationStyle) -> Void)?
    var onDismiss: (() -> Void)?
    var onHoverChanged: (() -> Void)?
    /// The voice key's keycap, in this view's coordinates; the panel opens above it.
    var anchor: CGRect = .zero { didSet { setNeedsLayout() } }

    private let panel = UIView()
    private var rows: [MenuRow] = []
    private var hoveredIndex: Int?
    private static let rowHeight: CGFloat = 36

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        panel.layer.cornerRadius = 13
        panel.layer.cornerCurve = .continuous
        panel.layer.shadowOffset = CGSize(width: 0, height: 4)
        panel.layer.shadowRadius = 12
        panel.layer.shadowOpacity = 1
        addSubview(panel)
        accessibilityViewIsModal = true
        rebuild()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    /// Updates row highlight while the user holds the key and slides into the menu.
    func updateDrag(at point: CGPoint) {
        let nextIndex = rows.firstIndex { $0.bounds.contains(convert(point, to: $0)) }
        guard nextIndex != hoveredIndex else { return }
        hoveredIndex = nextIndex
        for (idx, row) in rows.enumerated() {
            row.isSlideHovered = (idx == nextIndex)
        }
        if nextIndex != nil {
            onHoverChanged?()
        }
    }

    /// Commits a hovered row if the hold-and-slide ended inside the panel; otherwise leaves the menu open for a tap.
    func finishDrag(at point: CGPoint) {
        hoveredIndex = nil
        if let idx = rows.firstIndex(where: { $0.bounds.contains(convert(point, to: $0)) }) {
            rows[idx].trigger()
        } else {
            rows.forEach { $0.isSlideHovered = false }
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        // A tap outside the panel closes the menu.
        if let touch = touches.first, !panel.frame.contains(touch.location(in: self)) {
            onDismiss?()
        }
    }

    private func rebuild() {
        panel.backgroundColor = palette.popupFill
        panel.layer.borderColor = palette.popupBorder.cgColor
        panel.layer.borderWidth = 1 / max(1, traitCollection.displayScale)
        panel.layer.shadowColor = palette.popupShadow.cgColor
        rows.forEach { $0.removeFromSuperview() }
        // Original is kept for people who chose it in the app; the keyboard offers today's styles.
        rows = DictationStyle.allCases.filter { $0 != .legacy }.map { option in
            MenuRow(palette: palette, title: option.title, selected: option == style) { [weak self] in
                self?.onStyle?(option)
            }
        }
        rows.forEach(panel.addSubview)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width: CGFloat = 224
        let padding: CGFloat = 5
        // Opens away from the edge the key sits on: down from the strip, up from the keys.
        let opensDown = anchor.midY < bounds.midY
        let available = opensDown ? max(80, bounds.height - anchor.maxY - 6 - 4) : max(80, anchor.minY - 6 - 4)
        let rowH = min(Self.rowHeight, (available - 2 * padding) / CGFloat(max(1, rows.count)))
        let height = CGFloat(rows.count) * rowH + 2 * padding
        // Toward the screen's middle: from the key's right edge leftward on the right, from its
        // left edge rightward on the left.
        let towardRight = anchor.midX < bounds.midX
        let x = min(bounds.width - 6 - width, max(6, towardRight ? anchor.minX : anchor.maxX - width))
        let y = opensDown ? anchor.maxY + 6 : max(2, anchor.minY - 6 - height)
        panel.frame = CGRect(x: x, y: y, width: width, height: height)
        for (i, row) in rows.enumerated() {
            row.frame = CGRect(x: padding, y: padding + CGFloat(i) * rowH, width: width - 2 * padding, height: rowH)
        }
    }

    private final class MenuRow: UIControl {
        private let palette: FullKeyboardPalette
        private let title: String
        private let isChosen: Bool
        private let onTrigger: () -> Void
        var isSlideHovered = false { didSet { if isSlideHovered != oldValue { setNeedsDisplay() } } }

        init(palette: FullKeyboardPalette, title: String, selected: Bool, onTrigger: @escaping () -> Void) {
            self.palette = palette
            self.title = title
            self.isChosen = selected
            self.onTrigger = onTrigger
            super.init(frame: .zero)
            isOpaque = false
            backgroundColor = .clear
            contentMode = .redraw
            isAccessibilityElement = true
            accessibilityLabel = title
            accessibilityTraits = isChosen ? [.button, .selected] : .button
            addAction(UIAction { [weak self] _ in self?.onTrigger() }, for: .touchUpInside)
            addTarget(self, action: #selector(redraw), for: [.touchDown, .touchDragEnter, .touchDragExit, .touchCancel, .touchUpInside, .touchUpOutside])
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError() }

        func trigger() { onTrigger() }

        @objc private func redraw() { setNeedsDisplay() }

        override var isHighlighted: Bool {
            didSet { if isHighlighted != oldValue { setNeedsDisplay() } }
        }

        override func draw(_ rect: CGRect) {
            let activeHover = isHighlighted || isSlideHovered
            if isChosen || activeHover {
                // The menu is on the system look, so its pressed row is the system's grey.
                let fill = activeHover ? palette.systemPressedFill : palette.selectFill
                fill.setFill()
                UIBezierPath(roundedRect: bounds, cornerRadius: 8.5).fill()
            }
            let ink = isChosen ? palette.selectText : palette.textBase
            let font = UIFont.systemFont(ofSize: 15.5, weight: isChosen ? .medium : .regular)
            let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink]
            let size = (title as NSString).size(withAttributes: attributes)
            (title as NSString).draw(at: CGPoint(x: 12, y: bounds.midY - size.height / 2), withAttributes: attributes)
            guard isChosen else { return }
            let config = UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
            if let image = UIImage(systemName: "checkmark", withConfiguration: config)?
                .withTintColor(ink, renderingMode: .alwaysOriginal) {
                image.draw(at: CGPoint(x: bounds.maxX - 12 - image.size.width, y: bounds.midY - image.size.height / 2))
            }
        }
    }
}

/// A mask with one soft vertical edge: clear on one side, opaque on the other, and a
/// `feather`-wide ramp between, so whatever it uncovers comes in behind a soft edge, never a
/// hard crop. Move the edge with `place(bandStart:)` inside an animation.
final class StripRevealMask: UIView {
    static let feather: CGFloat = 44
    /// How far the mask reaches either side of its edge, past anything it covers.
    static let reach: CGFloat = 2000
    let opaqueAfter: Bool

    override class var layerClass: AnyClass { CAGradientLayer.self }

    init(opaqueAfter: Bool) {
        self.opaqueAfter = opaqueAfter
        super.init(frame: CGRect(x: 0, y: -200, width: Self.reach * 2 + Self.feather, height: 600))
        let gradient = layer as! CAGradientLayer
        let clear = UIColor.clear.cgColor
        let solid = UIColor.black.cgColor
        gradient.colors = opaqueAfter ? [clear, clear, solid, solid] : [solid, solid, clear, clear]
        let w = bounds.width
        gradient.locations = [0, NSNumber(value: Double(Self.reach / w)), NSNumber(value: Double((Self.reach + Self.feather) / w)), 1]
        gradient.startPoint = CGPoint(x: 0, y: 0.5)
        gradient.endPoint = CGPoint(x: 1, y: 0.5)
        isUserInteractionEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    /// Puts the ramp's start at `x` in the masked view's coordinates.
    func place(bandStart x: CGFloat) {
        center = CGPoint(x: x - Self.reach + bounds.width / 2, y: center.y)
    }
}
