// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXShared/FullKeyboard/View/FullKeyboardView+FullAccess.swift at f38e9fc.
// See Typing/NOTICE.md.

import UIKit

/// The strip's Full Access hints in the full keyboard: a voice key tapped without Allow Full
/// Access says what voice needs and where to turn it on, and a paste iOS asked about or
/// refused says where to stop it asking. Each is a strip notice for a few seconds.
extension FullKeyboardView {

    // MARK: - Without Full Access

    /// A voice key without Full Access: the keys keep typing, and the strip says, for a few
    /// seconds, that voice needs Allow Full Access and where to turn it on.
    func showFullAccessHint() {
        dismissStyleMenu()
        showsFullAccessHint = true
        refreshStrip()
        UIAccessibility.post(
            notification: .announcement,
            argument: "\(FullAccessHintView.title). \(FullAccessHintView.spokenPath)."
        )
        fullAccessHintHideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.hideFullAccessHint() }
        fullAccessHintHideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.fullAccessHintDuration, execute: work)
    }

    func hideFullAccessHint() {
        fullAccessHintHideWork?.cancel()
        fullAccessHintHideWork = nil
        guard showsFullAccessHint else { return }
        showsFullAccessHint = false
        refreshStrip()
    }

    func pasteFromClipboard() {
        let pasteboard = UIPasteboard.general
        // The read blocks while iOS asks Allow Paste, so its length tells whether it asked.
        let start = ProcessInfo.processInfo.systemUptime
        let read = KeyboardClipboardTracker.read(pasteboard)
        let readDuration = ProcessInfo.processInfo.systemUptime - start
        let text = read.flatMap { $0.isEmpty ? nil : $0 }
        let refused = text == nil && (pasteboard.hasStrings || pasteboard.hasURLs)
        let pointsToSetting = clipboard.shouldPointToAllowPaste(readDuration: readDuration, refused: refused)
        guard let text else {
            if pointsToSetting { showAllowPasteHint() }
            return
        }
        keyFeedback()
        clipboard.markPasted()
        if !pointsToSetting && readDuration < KeyboardClipboardTracker.askedReadDuration {
            clipboard.recordSilentPaste(pasteboard: pasteboard)
        }
        typingLog?.edit("paste", [TypingLogField("inserted", .string(text))])
        engine.commitHangulComposition()
        engine.forgetTextAroundKeys()
        engine.target.insertText(text)
        engine.textDidChange()
        typingLog?.context("paste")
        if pointsToSetting { showAllowPasteHint() }
        refreshStrip()
        onTextEdit?()
    }

    /// Two-line notice naming the setting after iOS asks Allow Paste or refuses a read.
    var allowPasteNotice: KeyboardStripNotice? {
        showsAllowPasteHint ? KeyboardClipboardTracker.allowPasteNotice : nil
    }

    /// For a few seconds after a paste iOS asked about (or refused), the strip names
    /// Paste from Other Apps › Allow.
    func showAllowPasteHint() {
        showsAllowPasteHint = true
        refreshStrip()
        UIAccessibility.post(notification: .announcement, argument: KeyboardClipboardTracker.allowPasteHintAnnouncement)
        allowPasteHintHideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.hideAllowPasteHint() }
        allowPasteHintHideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.allowPasteHintDuration, execute: work)
    }

    /// Typing takes the strip back before the hint's time is up.
    func hideAllowPasteHint() {
        allowPasteHintHideWork?.cancel()
        allowPasteHintHideWork = nil
        guard showsAllowPasteHint else { return }
        showsAllowPasteHint = false
        refreshStrip()
    }
}
