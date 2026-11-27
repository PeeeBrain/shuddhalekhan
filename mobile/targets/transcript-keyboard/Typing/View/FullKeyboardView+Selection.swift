// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXShared/FullKeyboard/View/FullKeyboardView+Selection.swift at f38e9fc.
// See Typing/NOTICE.md.

import UIKit

/// The strip's two-thumb selection actions and the dictation around them (Settings ›
/// Labs): Delete, Cut, Copy, Dictate or Cancel on the range two thumbs picked. Dictate
/// leaves the range in the field and its words replace it when they arrive; a cancelled or
/// empty dictation leaves it untouched. The range itself is the engine's
/// (`TrackpadSelectionSession`); this is the keyboard's side of it.
@MainActor
extension FullKeyboardView {
    /// Delete, Cut, Copy, Dictate or Cancel on the range two thumbs picked.
    func selectionAction(_ action: TrackpadSelectionSession.Action) {
        keyFeedback()
        if action == .dictate {
            startSelectionDictation()
            return
        }
        engine.performTrackpadSelectionAction(action) { [weak self] text in
            guard let self, self.model.hasFullAccess else { return }
            UIPasteboard.general.string = text
            self.clipboard.markOwnedCopy()
        }
        refreshStrip()
    }

    /// Dictate starts the keyboard's usual dictation at the range, leaving the text in place
    /// until its words arrive. A dictation that never starts (no session) leaves the range as it was.
    func startSelectionDictation() {
        guard engine.performTrackpadSelectionAction(.dictate, copy: { _ in }) else { return }
        selectionDictationStarted = false
        lastStagePhase = model.stagePhase
        voiceKeyHeld(from: "selection_dictate")
        // A dictation that never starts has no result to wait for: clear the pending
        // replacement. Nothing was taken out, so the range is simply left as it was.
        scheduleSelectionDictationClear(after: 3)
    }

    /// The dictation around a selection: recording cancels the timeout; a finished, failed or
    /// cancelled dictation with no result clears the pending replacement. The keyboard inserts a result
    /// (applying the replacement first) before it publishes the idle snapshot, so a result is
    /// replaced before this sees idle, and only a cancelled or empty one reaches the clear.
    func trackSelectionDictation() {
        let phase = model.stagePhase
        guard phase != lastStagePhase else { return }
        lastStagePhase = phase
        guard engine.hasPendingSelectionDictation else { return }
        switch phase {
        case .starting, .recording, .transcribing:
            selectionDictationStarted = true
            selectionDictationClear?.cancel()
            selectionDictationClear = nil
        case .idle:
            guard selectionDictationStarted else { return }
            engine.clearPendingSelectionDictation()
            selectionDictationStarted = false
        }
    }

    /// The dictation's text is about to insert: replace the range it was dictated for, when
    /// the field still shows it.
    func applyPendingSelectionDictation() {
        engine.applyPendingSelectionDictation()
    }

    func scheduleSelectionDictationClear(after delay: TimeInterval) {
        selectionDictationClear?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.selectionDictationStarted else { return }
            let phase = self.model.stagePhase
            guard phase != .starting, phase != .recording, phase != .transcribing else { return }
            self.engine.clearPendingSelectionDictation()
            self.refreshStrip()
        }
        selectionDictationClear = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
}
