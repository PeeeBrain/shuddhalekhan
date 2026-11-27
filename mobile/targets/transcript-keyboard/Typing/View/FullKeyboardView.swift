// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXShared/FullKeyboard/View/FullKeyboardView.swift at f38e9fc.
// See Typing/NOTICE.md.

import Combine
import UIKit

/// The full keyboard (vendored, see Typing/NOTICE.md): a 3-slot suggestion strip, the keys, long-press
/// accents, and the recording panel that replaces the strip while the keyboard session records.
/// Shuddhalekhan puts the Dictation key at the strip's trailing end and the Agent key at its leading
/// end; both drive the session through `KeyboardViewModel`.
@MainActor
final class FullKeyboardView: UIView {
    let model: KeyboardViewModel
    let engine: FullKeyboardEngine
    weak var hostController: UIInputViewController? {
        didSet {
            configureGlobe()
            // `init` resolves the language before the controller attaches (it is the caller's
            // to set), so report what is already known, not only later changes.
            if let reportedInputModeLanguage {
                hostController?.primaryLanguage = reportedInputModeLanguage
            }
        }
    }

    /// Fixtures force light or dark and portrait or landscape; the keyboard follows its field.
    var appearanceOverride: Bool? { didSet { applyAppearance() } }
    var orientationOverride: KeyboardOrientation? { didSet { setNeedsLayout() } }
    /// Haptics need Full Access.
    var allowsHaptics: () -> Bool = { false }
    /// Draws a stand-in backdrop where there is no system keyboard behind the view.
    var drawsBackdrop = false { didSet { applyAppearance() } }
    /// The keys typed, deleted, or pasted something (Learn how I type follows dictations).
    var onTextEdit: (() -> Void)?
    /// Undo dictation took the last dictation back.
    var onUndoDictation: (() -> Void)?
    /// The return key is about to type its line break.
    var onReturnKey: (() -> Void)?

    let stripView = KeyboardStripView()
    /// The strip's two-thumb selection: the range, then its actions (Settings › Labs).
    let selectionStrip = TrackpadSelectionStripView()
    /// The keys' touch surface; tests feed it touch samples.
    let plane: KeyboardKeyPlaneView
    let callout = KeyCalloutView()
    let accentCallout = AccentCalloutView()
    let dictationKey = VoiceKeyControl()
    /// The Agent key, the Dictation key's mirror at the strip's leading end.
    let agentKey: VoiceKeyControl = {
        let key = VoiceKeyControl()
        key.mode = .agent
        return key
    }()
    let globeButton = UIButton(type: .custom)
    /// The words' side of the soft edge the recording bar's dots come out of the Dictation key behind
    /// (`StripRevealMask`); only while the bar is coming, shown, or going.
    var wordsMask: StripRevealMask?
    var recordingPanel: VoiceRecordingPanel?
    private var styleMenu: DictationStyleMenuView?
    private(set) var palette = FullKeyboardPalette(isDark: false)
    private var didApplyPalette = false
    private var subscriptions: Set<AnyCancellable> = []
    var showsRecording = false
    /// The mode a voice key's press started, so only that key's release finishes it.
    private var heldMode: KeyboardSession.Mode?
    /// The page and case VoiceOver last read the keys in.
    private var spokenPage: (KeyboardLayer, Bool) = (.letters, false)
    /// A finger on the bar where no word is: holding it dictates as holding the Dictation key does.
    private var barHold = VoiceKeyGesture()
    private var barHoldTouch: UITouch?
    private var barHoldWork: DispatchWorkItem?
    private var lastDictation: DictationUndo?
    private let inputModeListTouch = InputModeListTouch()
    /// The model's stage last seen, for a selection's dictation ending
    /// (`FullKeyboardView+Selection`).
    var lastStagePhase: KeyboardViewModel.StagePhase?
    var selectionDictationStarted = false
    var selectionDictationClear: DispatchWorkItem?
    /// A selection took the strip: whether it was hidden before, so it goes back that way.
    var stripWasHiddenBeforeSelection = false
    var selectionTookStrip = false

    /// A word you typed whose slot you held: the strip offers Add to vocabulary until the text
    /// changes (`FullKeyboardView+Vocabulary`).
    var vocabularyOffer: String?
    private var undoHideWork: DispatchWorkItem?
    /// The Dictation key was tapped without Full Access: the strip says what dictation needs.
    var showsFullAccessHint = false
    var fullAccessHintHideWork: DispatchWorkItem?
    /// How long the Full Access hint stays unless a key or the strip is used first.
    static let fullAccessHintDuration: TimeInterval = 8
    private let haptics = UIImpactFeedbackGenerator(style: .light)
    /// Every key's touch-down tick (letters, space, delete and its repeats, shift, 123,
    /// return, suggestions), as hard as Settings › Keyboard › Strength asks. The Dictation key's hold
    /// and its menu keep `haptics`' fuller thud.
    var hapticStrength: KeyHapticStrength = .light {
        didSet {
            guard hapticStrength != oldValue else { return }
            keyTicks = UIImpactFeedbackGenerator(style: Self.keyTickStyle(hapticStrength))
            if allowsHaptics() { keyTicks.prepare() }
        }
    }
    private var keyTicks = UIImpactFeedbackGenerator(style: FullKeyboardView.keyTickStyle(.light))

    /// Apple's key haptic is a crisp tick, so every strength is a rigid impact (the sharpest
    /// style) but Strong, a fuller medium one. Light, the default, is 0.5 of a rigid tap and
    /// Medium 0.8; before both, a 0.65 light impact felt much weaker than Apple's to testers.
    static func keyTickStyle(_ strength: KeyHapticStrength) -> UIImpactFeedbackGenerator.FeedbackStyle {
        strength == .strong ? .medium : .rigid
    }

    static func keyTickIntensity(_ strength: KeyHapticStrength) -> CGFloat {
        switch strength {
        case .light: 0.5
        case .medium: 0.8
        case .strong: 1
        }
    }
    private let selectionHaptics = UISelectionFeedbackGenerator()
    let clipboard = KeyboardClipboardTracker()
    /// What the strip's Paste chip offers now.
    var stripOffer: KeyboardClipboardOffer?
    /// Settings › Labs › Hide word suggestions: the strip keeps its height, chips,
    /// status and notices but shows no words (`refreshStrip`).
    private var hidesWordSuggestions = false
    /// Settings › Labs › Emoji shortcodes, cached by `syncEmojiShortcodes`: the strip
    /// offers emoji for a ":name" and the closing ":" completes one while it is on.
    private(set) var emojiShortcodesEnabled = false
    /// Settings › Labs › Key colors: Automatic keeps iOS's glass; another theme
    /// paints the keyboard's own colours. Read again by `syncSettings`, which rebuilds the
    /// palette when it changes.
    private var keyboardTheme = FullKeyboardSettings().effectiveKeyboardTheme
    /// A paste iOS asked about or refused: the strip points to the setting that stops it.
    var showsAllowPasteHint = false
    var allowPasteHintHideWork: DispatchWorkItem?
    static let allowPasteHintDuration: TimeInterval = 8

    // MARK: Emoji (Settings › Keyboard › Emoji; FullKeyboardView+Emoji.swift)

    /// The keys' target: the field, or the emoji search while you search.
    let routedTarget: EmojiRoutedTarget
    /// Fixtures turn the emoji key, and with it the emoji suggestions, on or off; otherwise the
    /// App Group's switches.
    var emojiOverride: Bool? { didSet { refreshEmojiKey() } }
    /// Fixtures and tests turn the emoji suggestions alone on or off.
    var emojiSuggestionsOverride: Bool? { didSet { refreshEmojiKey() } }
    /// The strip offers emoji here: Emoji suggestions on, in a field that takes emoji.
    var showsEmojiSuggestions = false
    /// Fixtures and tests turn the ABC experiment on or off; otherwise the App Group's switch.
    var emojiLettersUnderEmojiKeyOverride: Bool? { didSet { setNeedsLayout() } }
    /// Where emoji use is kept; fixtures give a seeded store.
    var makeEmojiUsage: () -> EmojiUsageStore = { EmojiUsageStore() }
    var emojiLibrary: EmojiLibrary?
    var emojiPanel: EmojiPanelView?
    var emojiSearchField: EmojiSearchField?
    var emojiResults: EmojiRowView?
    var emojiResultEntries: [Int] = []
    var emojiSearchLift: CGFloat = 0
    /// Record typing logs, held back while you type a search.
    var suspendedTypingLog: TypingLogger?
    /// From the emoji key to the panel's suggestions laid out, for probes.
    var lastEmojiPanelLatency: TimeInterval?

    /// Exposed so unit tests can verify lazy allocation and teardown of the Metal recording panel.
    var hasAllocatedRecordingPanel: Bool { recordingPanel != nil }

    init(model: KeyboardViewModel, target: KeyboardTextTarget, autocorrect: AutocorrectEngine? = nil) {
        self.model = model
        routedTarget = EmojiRoutedTarget(document: target)
        engine = FullKeyboardEngine(target: routedTarget, autocorrect: autocorrect)
        plane = KeyboardKeyPlaneView(engine: engine)
        super.init(frame: .zero)
        backgroundColor = .clear

        addSubview(stripView)
        addSubview(plane)
        addSubview(selectionStrip)
        addSubview(dictationKey)
        addSubview(agentKey)
        addSubview(globeButton)
        addSubview(callout)
        addSubview(accentCallout)
        accentCallout.isHidden = true

        stripView.onSelectSuggestion = { [weak self] suggestion in
            guard let self else { return }
            self.keyFeedback()
            if suggestion.kind == .emoji {
                if self.acceptEmojiShortcode(suggestion) { return }
                self.recordEmojiUse(suggestion.replacement)
            }
            self.engine.acceptSuggestion(suggestion)
        }
        stripView.onHoldSuggestion = { [weak self] suggestion in self?.offerVocabulary(suggestion) }
        stripView.onUndoDictation = { [weak self] in self?.undoDictation() }
        stripView.onPaste = { [weak self] in self?.pasteFromClipboard() }
        stripView.onDismissNotice = { [weak self] in self?.dismissStripNotice() }
        // Add to vocabulary is the only notice with a button: the keyboard never opens the app.
        stripView.onOpenNotice = { [weak self] in
            guard let self, let word = self.vocabularyOffer else { return }
            self.keyFeedback()
            self.addToVocabulary(word)
        }
        stripView.onNextKeyboard = { [weak self] in
            // Never where Apple's keyboard is split, where the strip doesn't offer it either
            // (`InputModeListTouch`).
            guard let self, self.currentPosture?.splitsKeyboard == false else { return }
            self.typingLog?.ui("next_keyboard")
            self.hostController?.advanceToNextInputMode()
        }
        stripView.onKeyboardListTouch = { [weak self] chip, event in
            if event.touches(for: chip)?.first?.phase == .began { self?.typingLog?.ui("keyboard_list") }
            guard let self, let controller = self.hostController else { return }
            self.inputModeListTouch.forward(chip, with: event, to: controller, alwaysHoldsBackTap: true)
        }
        selectionStrip.onAction = { [weak self] action in self?.selectionAction(action) }

        globeButton.accessibilityLabel = "Next keyboard"
        globeButton.isAccessibilityElement = true
        globeButton.addTarget(self, action: #selector(globeTapped), for: .touchUpInside)

        dictationKey.onHold = { [weak self] in self?.voiceKeyHeld() }
        dictationKey.onHoldRelease = { [weak self] in self?.voiceKeyReleased() }
        agentKey.onHold = { [weak self] in self?.voiceKeyHeld(from: "agent_key", mode: .agent) }
        agentKey.onHoldRelease = { [weak self] in self?.voiceKeyReleased(from: "agent_key_release", mode: .agent) }
        dictationKey.onMenuOpen = { [weak self] point in
            guard let self else { return }
            // Styles are for dictation, which needs Full Access.
            guard self.model.hasFullAccess else {
                self.showFullAccessHint()
                return
            }
            self.typingLog?.ui("style_menu")
            self.showStyleMenu()
            self.forwardMenuPoint(point, release: false)
        }
        dictationKey.onMenuDrag = { [weak self] point in self?.forwardMenuPoint(point, release: false) }
        dictationKey.onMenuRelease = { [weak self] point in self?.forwardMenuPoint(point, release: true) }

        plane.onKeyDown = { [weak self] _ in self?.keyFeedback() }
        plane.onAccentMenuOpened = { [weak self] in self?.selectionFeedback() }
        engine.onSelectionStep = { [weak self] in self?.selectionFeedback() }
        engine.onChange = { [weak self] in self?.engineChanged() }
        engine.onEdit = { [weak self] in
            guard let self else { return }
            if self.routedTarget.isSearching {
                self.refreshEmojiSearch()
                return
            }
            self.hideUndo()
            self.vocabularyOffer = nil
            self.hideFullAccessHint()
            self.hideAllowPasteHint()
            self.refreshReturnKey()
            self.refreshStrip()
            self.onTextEdit?()
        }
        engine.onReturn = { [weak self] in
            guard self?.routedTarget.isSearching == false else { return }
            self?.onReturnKey?()
        }
        engine.onEmojiKey = { [weak self] in self?.emojiKeyTapped() }
        engine.onDismissKey = { [weak self] in self?.hostController?.dismissKeyboard() }
        routedTarget.onSearchReturn = { [weak self] in self?.endEmojiSearch() }

        model.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshFromModel() }
            .store(in: &subscriptions)

        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitVerticalSizeClass.self]) { (view: FullKeyboardView, _) in
            view.applyAppearance()
            view.setNeedsLayout()
        }

        engine.autocorrect.isEnabled = FullKeyboardSettings().autocorrect
        engine.autocorrect.allowsSwearing = FullKeyboardSettings().suggestSwearWords
        engine.autocorrect.setVocabulary(CustomVocabularySettings().terms)
        engine.autoCapitalizes = FullKeyboardSettings().autoCapitalization
        engine.showsKeyPopups = FullKeyboardSettings().keyPopups
        engine.trackpadSelectionState.enabled = FullKeyboardSettings().twoThumbSelection
        engine.deletesSwipedWordsLetterByLetter = FullKeyboardSettings().deletesSwipedWordsLetterByLetter
        engine.quickAccentsEnabled = FullKeyboardSettings().quickAccents
        syncEmojiShortcodes()
        hidesWordSuggestions = FullKeyboardSettings().hideWordSuggestions
        syncVoicePlacement()
        syncNumberRow()
        syncJoinsUnfoldedKeyboard()
        syncDvorakPunctuation()
        syncCommaPeriodKeys()
        refreshEmojiKey()
        syncSpatialAutocorrect()
        refreshLanguageSignals()
        syncLanguage()
        syncSwipeTyping()
        engine.configureForField()
        applyAppearance()
        refreshFromModel()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    // MARK: - Typing logs

    /// Record typing logs (Privacy › Advanced): set by the keyboard while a session may be logged,
    /// nil otherwise. The app's fixtures never set it.
    var typingLog: TypingLogger? {
        get { routedTarget.isSearching ? suspendedTypingLog : engine.typingLog }
        set {
            if routedTarget.isSearching {
                suspendedTypingLog = newValue
            } else {
                engine.typingLog = newValue
            }
        }
    }

    /// A typing log session began: write the layout, shift, and suggestions as they are now.
    func typingLogSessionBegan() {
        guard let log = engine.typingLog else { return }
        log.viewGeometry(size: bounds.size, safeArea: safeAreaInsets)
        engine.logState("session")
        log.commitGeometry()
        log.suggestionsChanged(engine.suggestions)
    }

    @objc private func globeTapped() {
        typingLog?.ui("globe")
    }

    // MARK: - Size

    static func orientation(for traits: UITraitCollection) -> KeyboardOrientation {
        traits.verticalSizeClass == .compact ? .landscape : .portrait
    }

    var orientation: KeyboardOrientation {
        orientationOverride ?? padOrientation ?? Self.orientation(for: traitCollection)
    }

    /// On an iPad, which way up its screen is (`KeyboardPadPlacement.orientation`); nil on an iPhone.
    private var padOrientation: KeyboardOrientation?

    var preferredHeight: CGFloat {
        keysHeight + lift
    }

    /// The strip and the keys, without the lift.
    private var keysHeight: CGFloat {
        KeyboardLayout.height(
            for: orientation, posture: engine.posture, phoneSize: engine.phoneSize, pad: engine.pad, numberRow: engine.hasNumberRow
        )
    }

    /// Room above the strip for the emoji search results. The strip itself keeps its height in
    /// every state, the recording bar's included.
    private var lift: CGFloat { emojiSearchLift }

    /// Asks the host to apply `preferredHeight` now (the keyboard extension resizes itself).
    var onPreferredHeightChange: (() -> Void)?

    /// How much of the lift the view actually has yet, so nothing jumps before the host grows it.
    var appliedLift: CGFloat {
        max(0, min(lift, bounds.height - keysHeight))
    }

    /// Reads which device and posture the keyboard is on, and how far iOS set it in from the
    /// screen's sides, from its window. The Duo's unfolded screen has regular size classes either
    /// way up, so the size classes alone can't tell its postures apart.
    private func syncPosture() {
        guard let screen = window?.windowScene?.screen ?? window?.screen else { return }
        let size = screen.bounds.size
        let posture = KeyboardPosture.current(screenSize: size, isFoldable: Self.isFoldable)
        let inset = posture == .phone ? 0 : max(0, (size.width - bounds.width) / 2)
        let phoneSize = KeyboardPhoneSize.current(screenSize: size)
        let pad = Self.isPad ? KeyboardPadPlacement.current(screenSize: size, keyboardWidth: bounds.width) : nil
        let padOrientation = pad.map { KeyboardPadPlacement.orientation(screenSize: size, placement: $0, keyboardWidth: bounds.width) }
        let postureChanges = posture != engine.posture
        let heightChanges = postureChanges || phoneSize != engine.phoneSize
            || pad != engine.pad || padOrientation != self.padOrientation
        engine.posture = posture
        engine.phoneSize = phoneSize
        engine.windowInset = inset
        engine.pad = pad
        self.padOrientation = padOrientation
        syncGlobe()
        if postureChanges { refreshStrip() }
        if heightChanges { onPreferredHeightChange?() }
    }

    /// The posture as the keyboard's window shows it now; nil on the Duo before it has one.
    var currentPosture: KeyboardPosture? { KeyboardPosture.current(in: window) }

    /// The keyboard's globe key where iOS asks for one, except floating on an iPad: iPadOS draws its own
    /// globe in the band under a floating keyboard.
    private func syncGlobe() {
        let globe = model.needsGlobeKey && engine.pad != .floating
        guard engine.showsGlobe != globe else { return }
        engine.showsGlobe = globe
        setNeedsLayout()
    }

    /// An iPad (the keyboard runs as an iPad keyboard even though the app is iPhone-only).
    static let isPad = UIDevice.current.userInterfaceIdiom == .pad

    /// The iPhone Duo (`KeyboardPosture.foldableModels`), read once per process.
    static let isFoldable: Bool = {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return KeyboardPosture.foldableModels.contains(simulated)
        }
        var system = utsname()
        uname(&system)
        let model = withUnsafeBytes(of: &system.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return KeyboardPosture.foldableModels.contains(model)
    }()

    // MARK: - Host events

    func warmUpTextCheckerAsync() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let checker = self.engine.autocorrect.checker as? SystemTextChecker else { return }
            checker.warmUp()
            // German's capitalisation list reads with the dictionary, off the open path, and only
            // while the German model is on: the dictionary engine never asks for it.
            if self.engine.language == .german, self.engine.letterOdds != nil,
               self.engine.autocorrect.germanCapitals == nil {
                self.engine.autocorrect.germanCapitals = GermanCapitals.bundled()
            }
            self.engine.refreshSuggestions()
        }
    }

    func loadLexicon(_ lexicon: UILexicon) {
        engine.autocorrect.loadLexicon(lexicon)
        engine.refreshSuggestions()
    }

    // MARK: - Language

    /// Fixtures pin one layout; otherwise the keyboard's Automatic: the iPhone's keyboards, then its
    /// preferred languages (Shuddhalekhan has no keyboard language settings).
    var languageOverride: KeyboardLanguage? {
        didSet { syncLanguage() }
    }

    /// Fixtures pin how the letters are arranged; otherwise each language types on its own layout.
    var letterLayoutOverride: KeyboardLetterLayout? {
        didSet { syncLanguage() }
    }

    /// The languages the space bar switches between and the one typing now.
    private(set) var languages = KeyboardLanguageList(languages: [.english], current: .english)
    /// The input mode's language last reported to the host (`UIInputViewController.primaryLanguage`),
    /// so the host's spelling and autocorrection follow the language typing.
    private(set) var reportedInputModeLanguage: String?
    private static let spellCheckLanguages = UITextChecker.availableLanguages

    /// The iPhone's keyboards and preferred languages, read when the keyboard appears, for
    /// Automatic before any dictation language is known.
    private var inputModeLanguages: [String] = []
    private var preferredLanguages: [String] = []

    private func refreshLanguageSignals() {
        inputModeLanguages = UITextInputMode.activeInputModes.compactMap(\.primaryLanguage)
        preferredLanguages = Locale.preferredLanguages
    }

    private func syncLanguage() {
        let language = languageOverride ?? KeyboardLanguage.automatic(
            dictationLanguage: nil,
            inputModes: inputModeLanguages,
            preferredLanguages: preferredLanguages
        )
        let list = KeyboardLanguageList(languages: [language], current: language)
        let letters = list.layout.offered(letterLayoutOverride)
        // The host spells and autocorrects in the input mode's language, which supersedes the
        // Info.plist's `mul` (`primaryLanguage`): report every change, a space-bar switch too.
        let identifier = list.current.inputModeLanguage
        if identifier != reportedInputModeLanguage {
            reportedInputModeLanguage = identifier
            hostController?.primaryLanguage = identifier
        }
        guard list != languages || engine.language != list.current || engine.letterLayout != letters else { return }
        languages = list
        engine.switchesLanguage = list.switches
        engine.layoutLanguage = list.layout == list.current ? nil : list.layout
        engine.letterLayout = letters
        engine.language = list.current
        engine.partnerLanguage = list.partner(available: Self.spellCheckLanguages)
        syncSpatialAutocorrect()
        refreshSpaceLabel()
        syncSwipeTyping()
        setNeedsLayout()
    }

    /// With two or more languages the space bar names the keyboard's.
    private func refreshSpaceLabel() {
        plane.spaceLabel = languages.spaceLabel
    }

    /// Settings › Labs › Emoji shortcodes, in the App Group: cached for the strip, and
    /// the engine's closing ":" hook is set only while it is on, so an off keyboard types a
    /// colon exactly as it did before the experiment.
    private func syncEmojiShortcodes() {
        emojiShortcodesEnabled = FullKeyboardSettings().emojiShortcodes
        engine.emojiShortcode = emojiShortcodesEnabled
            ? { [weak self] before in self?.emojiShortcodeReplacement(before: before) }
            : nil
    }

    func syncSettings() {
        syncLanguage()
        // Learn each language separately: each keyboard language's own learned words, and the
        // partner's own; Learn how I type's journal filters its fixes the same way.
        let learnsPerLanguage = TypingJournalSettings().learnsPerLanguage
        if engine.autocorrect.learnsPerLanguage != learnsPerLanguage {
            engine.autocorrect.learnsPerLanguage = learnsPerLanguage
            engine.refreshSuggestions()
        }
        let journal = TypingJournal.sharedIfEnabled()
        if engine.journal !== journal {
            engine.journal = journal
        }
        // Adaptive touch keeps its averages on disk only with Full Access; without, in memory.
        let adaptive = AdaptiveTouch.sharedIfEnabled(persistent: hostController?.hasFullAccess == true)
        if engine.adaptiveTouch !== adaptive {
            engine.adaptiveTouch = adaptive
        }
        engine.korean.isEnabled = FullKeyboardSettings().koreanKeyboard
        engine.showsKeyPopups = FullKeyboardSettings().keyPopups
        engine.autoCapitalizes = FullKeyboardSettings().autoCapitalization
        engine.deletesSwipedWordsLetterByLetter = FullKeyboardSettings().deletesSwipedWordsLetterByLetter
        engine.quickAccentsEnabled = FullKeyboardSettings().quickAccents
        syncEmojiShortcodes()
        let selectionEnabled = FullKeyboardSettings().twoThumbSelection
        engine.trackpadSelectionState.enabled = selectionEnabled
        // Turned off mid-selection: end it now rather than let a thumb keep picking.
        if !selectionEnabled, engine.isSelectionActive {
            plane.cancelAllTouches()
        }
        let hidesSuggestions = FullKeyboardSettings().hideWordSuggestions
        if hidesSuggestions != hidesWordSuggestions {
            hidesWordSuggestions = hidesSuggestions
            refreshStrip()
        }
        let theme = FullKeyboardSettings().effectiveKeyboardTheme
        if theme != keyboardTheme {
            keyboardTheme = theme
            applyAppearance()
        }
        hapticStrength = FullKeyboardSettings().hapticStrength
        syncVoicePlacement()
        syncNumberRow()
        syncJoinsUnfoldedKeyboard()
        syncDvorakPunctuation()
        syncCommaPeriodKeys()
        refreshEmojiKey()
        let wantsAutocorrect = FullKeyboardSettings().autocorrect
        if engine.autocorrect.isEnabled != wantsAutocorrect {
            engine.autocorrect.isEnabled = wantsAutocorrect
            engine.refreshSuggestions()
        }
        let vocabulary = CustomVocabularySettings().terms
        if engine.autocorrect.vocabulary != vocabulary {
            engine.autocorrect.setVocabulary(vocabulary)
            engine.refreshSuggestions()
        }
        let wantsSwearing = FullKeyboardSettings().suggestSwearWords
        if engine.autocorrect.allowsSwearing != wantsSwearing {
            engine.autocorrect.allowsSwearing = wantsSwearing
            engine.refreshSuggestions()
        }
        syncSpatialAutocorrect()
        syncSwipeTyping()
    }

    /// Fixtures pin where the Dictation key sits; otherwise the voice-key placement setting.
    var voicePlacementOverride: VoiceKeyPlacement? { didSet { syncVoicePlacement() } }

    /// Fixtures and tests turn Swipe typing on or off; otherwise its switch in Settings › Keyboard.
    var swipeOverride: Bool? { didSet { syncSwipeTyping() } }

    /// Settings › Keyboard › Swipe typing (on by default): on the English and Spanish layouts, a
    /// drag across the letters types a word, read with the layout language's bundled model, and
    /// with Settings › Labs › Swipe typing in more languages on also in every language
    /// that has one (`FullKeyboardSettings.swipesIn`). Off under VoiceOver, which has its own
    /// way to type. Elsewhere a drag stays a slide to another key.
    private func syncSwipeTyping() {
        let settings = FullKeyboardSettings()
        let on = (swipeOverride ?? settings.swipeTyping) && settings.swipesIn(engine.language)
            && !UIAccessibility.isVoiceOverRunning
        let model = on ? settings.typingModel(for: engine.language) : nil
        if plane.swipe?.model !== model {
            plane.swipe = model.map { SwipeTyping(engine: engine, model: $0) }
        } else {
            plane.swipe?.syncWords()
        }
    }

    /// Settings › Keyboard › Spatial autocorrect (on by default): maps the layout language's
    /// bundled model when the keyboard opens (English, Spanish, French, and German while its experiment
    /// in Settings › Labs is on; others keep `UITextChecker`), and moves the keys'
    /// centres to where Learn how I type saw you tap. The same word list lets the likely next
    /// letter claim a few points of its neighbour's touch target whether or not Spatial
    /// autocorrect is on (`FullKeyboardEngine.letterOdds`; only while autocorrecting).
    private func syncSpatialAutocorrect() {
        let settings = FullKeyboardSettings()
        let words = settings.typingModel(for: engine.language)
        if engine.letterOdds !== words {
            engine.letterOdds = words
        }
        let model = settings.spatialAutocorrect ? words : nil
        if engine.autocorrect.decoder?.model !== model {
            engine.autocorrect.decoder = model.map { TypingDecoder(model: $0) }
            engine.refreshSuggestions()
        }
        // Bilingual autocorrect reads the same taps with the other language's model, where it has one.
        if let partner = engine.autocorrect.partner {
            let theirs = settings.spatialAutocorrect ? settings.typingModel(for: partner.language) : nil
            if partner.decoder?.model !== theirs {
                partner.decoder = theirs.map { TypingDecoder(model: $0) }
                engine.refreshSuggestions()
            }
        }
        let keys = model == nil ? [:] : (engine.journal?.current.keys ?? [:])
        engine.tapOffsets = TypingDecoder.offsets(from: keys, layout: engine.layout)
    }

    /// The field or its contents changed outside these keys.
    func textDidChange() {
        applyAppearance()
        let field = engine.field
        let routeField = KeyboardFieldRouting.route(for: engine.target.keyboardType).field
        // While you search emoji the keys still type the query, whatever the host changed.
        if routedTarget.isSearching {
            refreshReturnKey()
            return
        }
        // A field change (or the host's own edit) ends a range whose text no longer holds,
        // and clears any Dictate still waiting on its words.
        engine.selectionTextChanged()
        if routeField != field {
            plane.cancelAllTouches()
            engine.configureForField()
            refreshEmojiKey()
        } else {
            engine.textDidChange()
        }
        hideUndoIfMoved()
        refreshReturnKey()
        refreshStrip()
    }

    /// The keyboard came on screen for a (possibly new) field.
    func prepareForField() {
        stripView.appearing = true
        closeEmojiPanel()
        refreshLanguageSignals()
        syncSettings()
        plane.cancelAllTouches()
        engine.configureForField()
        refreshReturnKey()
        applyAppearance()
        refreshStrip()
        dismissStyleMenu()
        if allowsHaptics() {
            keyTicks.prepare()
            selectionHaptics.prepare()
        }
    }

    /// The keyboard is on screen: from here the strip's words roll as they change.
    func keyboardDidAppear() {
        stripView.appearing = false
    }

    /// Frees non-essential UI and Metal drawables when the extension approaches its memory ceiling.
    func handleMemoryWarning() {
        dismissStyleMenu()
        if emojiPanel == nil {
            emojiLibrary = nil
            EmojiLibrary.evictCached()
        }
        emojiPanel?.glyphs.purge()
        if !showsRecording, let panel = recordingPanel {
            panel.tearDown()
            panel.removeFromSuperview()
            recordingPanel = nil
        }
    }

    /// The session's dictation went in; offer to take it back (`undo`, nil when the host didn't confirm
    /// it) until the cursor or the text around it changes.
    func didInsertDictation(undo: DictationUndo?) {
        engine.commitHangulComposition()
        lastDictation = undo
        engine.clearPendingSelectionDictation()
        refreshStrip()
        undoHideWork?.cancel()
        if undo != nil {
            let work = DispatchWorkItem { [weak self] in self?.hideUndo() }
            undoHideWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: work)
        }
        engine.forgetTextAroundKeys()
        engine.textDidChange()
        refreshReturnKey()
    }

    // MARK: - Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        syncPosture()
        let isLandscape = orientation == .landscape
        engine.typingLog?.viewGeometry(size: bounds.size, safeArea: safeAreaInsets)
        engine.orientation = orientation
        engine.horizontalInset = isLandscape ? max(safeAreaInsets.left, safeAreaInsets.right) : 0
        engine.width = bounds.width
        let lift = appliedLift
        engine.availableHeight = bounds.height - lift
        engine.typingLog?.commitGeometry()
        let layout = engine.layout

        let content = CGRect(x: 0, y: lift, width: bounds.width, height: bounds.height - lift)
        plane.frame = content
        callout.frame = content
        accentCallout.frame = content
        stripView.frame = layout.stripFrame.offsetBy(dx: 0, dy: lift)
        selectionStrip.frame = stripView.frame
        stripView.slotFrames = layout.stripSlotFrames.map { $0.offsetBy(dx: -layout.stripFrame.minX, dy: -layout.stripFrame.minY) }
        stripView.pillInset = layout.metrics.stripInset
        stripView.textCenterY = layout.metrics.stripTextCenter
        stripView.chipHeight = layout.metrics.stripChipHeight
        stripView.appleBar = layout.metrics.appleBar
        stripView.dividerBesideVoiceKey = layout.metrics.appleBar && layout.key(.voice).map { $0.row < 0 } == true
        stripView.voiceKeyOnLeading = layout.voiceKeyOnLeading
        stripView.barMidX = layout.stripBarFrame.midX - layout.stripFrame.minX
        // The bar from the keyboard's top to the strip's bottom, between the two voice keys.
        var bar = CGRect(x: layout.stripBarFrame.minX, y: 0, width: layout.stripBarFrame.width, height: layout.stripBarFrame.maxY)
        if let voice = layout.key(.voice), voice.row < 0, let agent = layout.agentKey {
            bar = CGRect(x: agent.hitFrame.maxX, y: bar.minY, width: voice.hitFrame.minX - agent.hitFrame.maxX, height: bar.height)
        }
        stripView.barTouchFrame = bar.offsetBy(dx: -layout.stripFrame.minX, dy: -layout.stripFrame.minY)

        dictationKey.cornerRadius = layout.metrics.cornerRadius
        if let voice = layout.key(.voice) {
            dictationKey.inStrip = voice.row < 0
            // Bounds and centre: the key may be mid-scale as the recording bar comes and goes.
            let hit = voice.hitFrame.offsetBy(dx: 0, dy: lift)
            dictationKey.bounds = CGRect(origin: .zero, size: hit.size)
            dictationKey.center = CGPoint(x: hit.midX, y: hit.midY)
            dictationKey.keycapFrame = voice.frame.offsetBy(dx: -voice.hitFrame.minX, dy: -voice.hitFrame.minY)
            dictationKey.markCenterY = layout.metrics.stripTop + layout.metrics.stripTextCenter - voice.hitFrame.minY
        }
        agentKey.isHidden = layout.agentKey == nil || emojiPanel != nil || (showsRecording && !agentKey.isTracking)
        if let agent = layout.agentKey {
            agentKey.inStrip = true
            agentKey.cornerRadius = layout.metrics.cornerRadius
            let hit = agent.hitFrame.offsetBy(dx: 0, dy: lift)
            agentKey.bounds = CGRect(origin: .zero, size: hit.size)
            agentKey.center = CGPoint(x: hit.midX, y: hit.midY)
            agentKey.keycapFrame = agent.frame.offsetBy(dx: -agent.hitFrame.minX, dy: -agent.hitFrame.minY)
            agentKey.markCenterY = layout.metrics.stripTop + layout.metrics.stripTextCenter - agent.hitFrame.minY
        }
        if let globe = layout.key(.globe), emojiPanel == nil || routedTarget.isSearching {
            globeButton.isHidden = false
            globeButton.frame = globe.hitFrame.offsetBy(dx: 0, dy: lift)
        } else {
            globeButton.isHidden = true
        }
        layoutEmoji(content: content, lift: lift)

        if let panel = recordingPanel {
            panel.frame = recordingPanelFrame
            panel.horizontalInset = layout.horizontalInset
            panel.metrics = layout.metrics
            panel.sideKeyWidth = layout.modifierWidth
            panel.voiceKeyOnLeading = layout.voiceKeyOnLeading
        }
        if let menu = styleMenu, let voice = layout.key(.voice) {
            menu.frame = bounds
            menu.anchor = voice.frame
        }
        plane.setNeedsDisplay()
        updateCallout()
    }

    // MARK: - State

    private func applyAppearance() {
        let isDark = appearanceOverride
            ?? FullKeyboardPalette.isDark(traits: traitCollection)
        let next = FullKeyboardPalette(isDark: isDark, theme: keyboardTheme)
        // iOS's glass is the background, with or without a theme: a theme colours the keys.
        backgroundColor = drawsBackdrop ? next.backdrop : .clear
        stripView.inSystemPlatter = !drawsBackdrop
        guard next != palette || !didApplyPalette else { return }
        didApplyPalette = true
        palette = next
        stripView.palette = next
        selectionStrip.palette = next
        plane.palette = next
        callout.palette = next
        callout.setNeedsDisplay()
        accentCallout.palette = next
        dictationKey.palette = next
        agentKey.palette = next
        recordingPanel?.palette = next
        styleMenu?.palette = next
        emojiPanel?.palette = next
        emojiSearchField?.palette = next
        emojiResults?.palette = next
    }

    func refreshReturnKey() {
        plane.returnStyle = ReturnKeyStyle(engine.target.returnKeyType)
        plane.returnIsEnabled = ReturnKeyStyle.isEnabled(
            automatically: engine.target.enablesReturnKeyAutomatically,
            hasText: engine.target.hasText
        )
    }

    private func refreshFromModel() {
        syncGlobe()
        let recording = model.stagePhase == .starting || model.stagePhase == .recording || model.stagePhase == .transcribing
        if recording != showsRecording {
            setRecording(recording)
        }
        refreshRecordingPanel()
        styleMenu?.style = model.style
        trackSelectionDictation()
        refreshStrip()
    }

    func refreshStrip() {
        // A two-thumb selection takes the strip: the range while both thumbs are down, then
        // its actions. The keyboard's own strip (suggestions, Undo, chips) waits behind it.
        let selection = engine.selectionPresentation
        selectionStrip.update(selection, canUseClipboard: model.hasFullAccess)
        // Only a selection changes the strip's visibility: the emoji panel and the recording
        // bar hide and show it themselves, and refreshing must leave them alone.
        if selection != nil, !selectionTookStrip {
            stripWasHiddenBeforeSelection = stripView.isHidden
            stripView.isHidden = true
            selectionTookStrip = true
        } else if selection == nil, selectionTookStrip {
            selectionTookStrip = false
            stripView.isHidden = stripWasHiddenBeforeSelection || emojiPanel != nil || showsRecording
        }
        // Without Full Access the strip suggests and corrects like any keyboard's; what
        // voice needs shows only once a voice key is tapped (`showFullAccessHint`).
        let status: String? = nil
        let clipboardOffer = clipboard.offer(
            textContentType: engine.target.textContentType,
            keyboardType: engine.target.keyboardType,
            autocorrectionType: engine.target.autocorrectionType,
            fieldIsEmpty: !engine.target.hasText,
            hasFullAccess: model.hasFullAccess,
            canSwitchKeyboard: currentPosture.map { !$0.splitsKeyboard } ?? false
        )
        stripOffer = clipboardOffer
        var suggestions = withStripEmoji(engine.suggestions, quiet: lastDictation != nil || status != nil || clipboardOffer != nil)
        // The experiment hides the words, not the strip: Undo, Paste, status, notices and the
        // Dictation key keep their places, and an empty strip offers the clipboard as it does when no
        // word is suggested. What you typed before a correction (`.revert`) stays, so Delete
        // after a corrected word can still put it back; keep literal, swipe readings, next
        // words and the finished word's emoji go. Autocorrect still reads
        // `engine.suggestions`, never this.
        if hidesWordSuggestions {
            suggestions = suggestions.filter { $0.kind == .revert }
        }
        stripView.update(
            suggestions: suggestions,
            showsUndo: lastDictation != nil,
            statusText: status,
            clipboard: clipboardOffer,
            fullAccessHint: showsFullAccessHint && !model.hasFullAccess,
            notice: sessionNotice ?? allowPasteNotice ?? vocabularyNotice
        )
    }

    /// The session's message (connection, a failure, Sent to the agent), one line with ✕.
    private var sessionNotice: KeyboardStripNotice? {
        model.notice.map { KeyboardStripNotice(title: $0, detail: "", button: "", dismissible: true) }
    }

    /// Lifts the keys' level dots while the session records (0–1, about 15 a second).
    func pushLevel(_ level: CGFloat) {
        recordingPanel?.push(level: level)
    }

    /// The notice's ✕ puts away the notice that shows.
    func dismissStripNotice() {
        if sessionNotice != nil { model.onDismissNotice?() }
    }

    func refreshRecordingPanel() {
        guard let panel = recordingPanel, showsRecording else { return }
        panel.update(
            phase: model.stagePhase,
            mode: model.mode
        )
    }

    func makeRecordingPanel() -> VoiceRecordingPanel {
        let panel = VoiceRecordingPanel()
        panel.alpha = 0
        panel.onDone = { [weak self] in
            self?.typingLog?.ui("dictation_stop")
            self?.model.onStop?()
        }
        panel.onCancel = { [weak self] in
            self?.typingLog?.ui("dictation_cancel")
            self?.model.onCancel?()
        }
        panel.voiceKeyOnLeading = engine.layout.voiceKeyOnLeading
        insertSubview(panel, belowSubview: callout)
        recordingPanel = panel
        setNeedsLayout()
        return panel
    }

    private func engineChanged() {
        // A new selection replaces any Dictate still waiting on its words.
        if engine.isSelectionActive { engine.clearPendingSelectionDictation() }
        plane.setNeedsDisplay()
        let page = (engine.layerState.layer, engine.isUppercase)
        if page != spokenPage {
            spokenPage = page
            // VoiceOver re-reads the drawn keys' names after 123, #+= or shift.
            if UIAccessibility.isVoiceOverRunning { UIAccessibility.post(notification: .layoutChanged, argument: nil) }
        }
        updateCallout()
        refreshStrip()
        if globeButton.isHidden != (engine.layout.key(.globe) == nil) || dictationKey.frame != engine.layout.key(.voice)?.hitFrame
            || agentKey.frame != engine.layout.agentKey?.hitFrame {
            setNeedsLayout()
        }
    }

    private func updateCallout() {
        if let menu = engine.activeAccentMenu {
            endCalloutLinger()
            callout.show(nil, label: "")
            accentCallout.show(menu)
            return
        }
        accentCallout.show(nil)
        let layout = engine.layout
        if engine.showsKeyPopups, let key = engine.previewKey, let balloon = layout.balloon(for: key) {
            endCalloutLinger()
            let label = KeyboardKeyPlaneView.keycapLabel(engine.displayLabel(for: key))
            callout.show(balloon, label: label, style: KeyCalloutView.style(for: label))
            shownPreviewKind = key.kind
        } else if let kind = shownPreviewKind, calloutLingerWork == nil, engine.touches.isEmpty {
            // The finger lifted: Apple's pop-up and its grey key stay up 3 frames more (about
            // 50 ms after the letter lands, iOS 27.2 at 60 fps), then go in one frame.
            plane.lingeringKind = kind
            let work = DispatchWorkItem { [weak self] in self?.endCalloutLinger() }
            calloutLingerWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + KeyCalloutView.linger, execute: work)
        } else if calloutLingerWork == nil {
            shownPreviewKind = nil
            callout.show(nil, label: "")
        }
    }

    /// The key whose pop-up is up, or lingering after the finger lifted.
    private var shownPreviewKind: KeyKind?
    private var calloutLingerWork: DispatchWorkItem?

    private func endCalloutLinger() {
        calloutLingerWork?.cancel()
        calloutLingerWork = nil
        guard plane.lingeringKind != nil || shownPreviewKind != nil else { return }
        plane.lingeringKind = nil
        if engine.previewKey == nil {
            shownPreviewKind = nil
            callout.show(nil, label: "")
        }
    }

    // MARK: - Actions

    /// The system key click (`KeyboardInputView`), one for every key, delete and shift too:
    /// Apple's keyboard plays other sounds for those, but the click is the only keyboard sound
    /// a keyboard may play. Tests count it.
    var playInputClick: () -> Void = { UIDevice.current.playInputClick() }

    /// A key went down (or delete repeated): its click, and its tick while haptics are allowed.
    func keyFeedback() {
        playInputClick()
        if allowsHaptics() {
            keyTicks.impactOccurred(intensity: Self.keyTickIntensity(hapticStrength))
            keyTicks.prepare()
        }
    }

    func selectionFeedback() {
        if allowsHaptics() {
            selectionHaptics.selectionChanged()
            selectionHaptics.prepare()
        }
    }

    /// A tap or still hold on a voice key, or a hold on the bar where no word is (`from`).
    func voiceKeyHeld(from source: String = "dictation_key", mode: KeyboardSession.Mode = .dictate) {
        // Any dictation the person starts themselves replaces a selection Dictate still
        // waiting on its words.
        if source != "selection_dictate" { engine.clearPendingSelectionDictation() }
        if allowsHaptics() { haptics.impactOccurred() }
        dismissStyleMenu()
        // The session's loopback connection needs Full Access: say so instead of a start that can't.
        guard model.hasFullAccess else {
            heldMode = nil
            return showFullAccessHint()
        }
        // While one key's request runs, the other key neither starts nor owns the release.
        guard model.stagePhase == .idle else { return }
        typingLog?.ui(source, [TypingLogField("mode", .string(mode.rawValue))])
        heldMode = mode
        model.onStart?(mode)
    }

    /// Push to talk: lifting the finger after a hold finishes the dictation the hold started,
    /// as Done does. A hold that opened the keyboard has nothing to finish here.
    private func voiceKeyReleased(from source: String = "dictation_key_release", mode: KeyboardSession.Mode = .dictate) {
        guard heldMode == mode else { return }
        heldMode = nil
        typingLog?.ui("dictation_stop", [TypingLogField("from", .string(source))])
        model.onStop?()
    }

    // MARK: - Holding the bar

    /// Apple's long press: a still finger this long on the bar where no word is dictates.
    static let barHoldDuration: TimeInterval = 0.4

    /// Whether a finger at `point` may hold the bar to dictate. Only touches nothing else took
    /// reach here (an empty slot, beside the Dictation key, a bar with no words); a word's slot,
    /// the Dictation key and the keys take their own. Not while the bar shows the Full Access hint
    /// or a notice, or a dictation, the emoji panel or the style menu is up.
    private func takesBarHold(at point: CGPoint) -> Bool {
        let m = engine.layout.metrics
        let bar = CGRect(x: 0, y: appliedLift, width: bounds.width, height: m.stripTop + m.stripHeight)
        guard bar.contains(point), !showsRecording, emojiPanel == nil, styleMenu == nil,
              !(showsFullAccessHint && !model.hasFullAccess), vocabularyNotice == nil, sessionNotice == nil
        else { return false }
        return model.stagePhase == .idle
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard barHoldTouch == nil, let touch = touches.first, takesBarHold(at: touch.location(in: self)) else {
            super.touchesBegan(touches, with: event)
            return
        }
        barHoldTouch = touch
        barHold.touchDown(at: touch.location(in: self))
        let work = DispatchWorkItem { [weak self] in self?.barHoldElapsed() }
        barHoldWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.barHoldDuration, execute: work)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = barHoldTouch, touches.contains(touch) else {
            super.touchesMoved(touches, with: event)
            return
        }
        // A slide before the hold is no hold (the bar has no menu); after it, moves don't matter.
        if barHold.touchMoved(to: touch.location(in: self)) == .openMenu { endBarHold() }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = barHoldTouch, touches.contains(touch) else {
            super.touchesEnded(touches, with: event)
            return
        }
        // A tap does nothing; lifting after the hold finishes the dictation it started.
        let output = barHold.touchUp()
        endBarHold()
        if output == .release { voiceKeyReleased(from: "bar_release") }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = barHoldTouch, touches.contains(touch) else {
            super.touchesCancelled(touches, with: event)
            return
        }
        // As the Dictation key's: a hold that already fired keeps dictating (Done finishes it).
        endBarHold()
    }

    private func barHoldElapsed() {
        barHoldWork = nil
        guard barHoldTouch != nil, barHold.holdElapsed() == .hold else { return }
        guard let touch = barHoldTouch, takesBarHold(at: touch.location(in: self)) else {
            endBarHold()
            return
        }
        voiceKeyHeld(from: "bar_hold")
    }

    private func endBarHold() {
        barHoldWork?.cancel()
        barHoldWork = nil
        barHold.cancel()
        barHoldTouch = nil
    }

    /// Hold and slide: light the row under the finger, and pick it on release.
    private func forwardMenuPoint(_ point: CGPoint, release: Bool) {
        guard let menu = styleMenu else { return }
        let local = dictationKey.convert(point, to: menu)
        if release {
            menu.finishDrag(at: local)
        } else {
            menu.updateDrag(at: local)
        }
    }

    private func showStyleMenu() {
        guard styleMenu == nil, !showsRecording else { return }
        if allowsHaptics() {
            haptics.impactOccurred()
            haptics.prepare()
        }
        plane.cancelAllTouches()
        let menu = DictationStyleMenuView()
        menu.palette = palette
        menu.style = model.style
        menu.onHoverChanged = { [weak self] in self?.selectionFeedback() }
        menu.onStyle = { [weak self] style in
            self?.typingLog?.ui("style", [
                TypingLogField("style", .string(style.rawValue)),
                TypingLogField("from", .string("style_menu")),
            ])
            self?.model.onStyleSelected?(style)
            self?.dismissStyleMenu()
        }
        menu.onDismiss = { [weak self] in self?.dismissStyleMenu() }
        addSubview(menu)
        styleMenu = menu
        setNeedsLayout()
        layoutIfNeeded()
    }

    func dismissStyleMenu() {
        styleMenu?.removeFromSuperview()
        styleMenu = nil
    }

    /// Whether the cursor is still right after the dictation, with the same text either side.
    private func canUndo(_ undo: DictationUndo) -> Bool {
        let target = engine.target
        return undo.matches(before: target.documentContextBeforeInput ?? "",
                            after: target.documentContextAfterInput ?? "", selected: target.selectedText)
    }

    /// Moved or edited since the dictation: no button that does nothing.
    func hideUndoIfMoved() {
        if let undo = lastDictation, !canUndo(undo) { hideUndo() }
    }

    private func undoDictation() {
        engine.commitHangulComposition()
        guard let undo = lastDictation else { return }
        if canUndo(undo) {
            typingLog?.edit("undo_dictation", [TypingLogField("deleted", .string(undo.text))])
            for _ in 0..<undo.text.count {
                engine.target.deleteBackward()
            }
            onUndoDictation?()
        } else {
            typingLog?.ui("undo_dictation", [TypingLogField("applied", .bool(false))])
        }
        hideUndo()
        engine.forgetTextAroundKeys()
        engine.textDidChange()
        typingLog?.context("undo_dictation")
        refreshReturnKey()
    }

    func hideUndo() {
        undoHideWork?.cancel()
        undoHideWork = nil
        if lastDictation != nil {
            lastDictation = nil
            refreshStrip()
        }
    }

    /// The globe's touches go to UIKit's keyboard list (`InputModeListTouch`).
    private func configureGlobe() {
        globeButton.removeTarget(nil, action: nil, for: .allEvents)
        guard hostController != nil else { return }
        globeButton.addTarget(self, action: #selector(globeTouch(_:with:)), for: .allTouchEvents)
    }

    @objc private func globeTouch(_ sender: UIButton, with event: UIEvent) {
        guard let controller = hostController else { return }
        inputModeListTouch.forward(sender, with: event, to: controller)
    }
}
