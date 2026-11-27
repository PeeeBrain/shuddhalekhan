// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXShared/FullKeyboard/View/FullKeyboardView+Recording.swift at f38e9fc.
// See Typing/NOTICE.md.

import UIKit

/// Recording in and out: the Dictation key hands its spot to the recording panel, and the words and
/// the dots trade places behind one soft edge. The Agent key fades with the words.
@MainActor
extension FullKeyboardView {
    /// Recording in and out with no shape between: the Dictation key hands its spot to ✓ (the key
    /// leaving as ✓ arrives, on the same frame), ✕ slides out from under ✓, and the dots come
    /// out of the key behind a soft edge that runs across the bar, wiping the words as it goes.
    /// Going back, the edge runs home into the key, the words return behind it, ✕ tucks under
    /// ✓ and the key takes its spot back. Reduce Motion crossfades instead.
    func setRecording(_ recording: Bool) {
        showsRecording = recording
        dismissStyleMenu()
        if recording { closeEmojiPanel() }
        let animated = window != nil
        let travels = animated && !StripMotion.reduced && engine.layout.key(.voice).map { $0.row < 0 } == true
        stripView.holdsStill = recording || recordingPanel != nil
        if recording {
            plane.cancelAllTouches()
            hideUndo()
            let panel = recordingPanel ?? makeRecordingPanel()
            panel.palette = palette
            panel.frame = recordingPanelFrame
            refreshRecordingPanel()
            panel.isHidden = false
            panel.layoutIfNeeded()
            guard travels else {
                endReveal(panel)
                panel.setControls(shown: true)
                fade(in: [panel], out: [stripView, dictationKey, agentKey], duration: animated ? StripMotion.reducedFade : 0)
                return
            }
            panel.alpha = 1
            let fresh = beginReveal(panel)
            if fresh {
                UIView.performWithoutAnimation { panel.setControls(shown: false) }
            }
            StripMotion.animate(StripMotion.grow, fresh: fresh, {
                self.placeReveal(open: true, panel: panel)
            }, completion: { [weak self] _ in
                // Masked away, the words would still take touches.
                guard let self, self.showsRecording else { return }
                self.stripView.isHidden = true
            })
            StripMotion.animate(StripMotion.settle, fresh: fresh) { panel.setControls(shown: true) }
            StripMotion.animate(StripMotion.settleExit, {
                self.dictationKey.alpha = 0
                self.dictationKey.transform = self.voiceKeyTucked
                self.agentKey.alpha = 0
            }, completion: { [weak self] _ in
                // A voice key still held for push to talk stays in the window (at alpha 0), so its
                // touch keeps arriving and lifting the finger finishes the request.
                guard let self, self.showsRecording else { return }
                if !self.dictationKey.isTracking { self.dictationKey.isHidden = true }
                if !self.agentKey.isTracking { self.agentKey.isHidden = true }
            })
        } else if let panel = recordingPanel {
            let finish = { [weak self, weak panel] in
                guard let self, !self.showsRecording, let panel, panel === self.recordingPanel else { return }
                self.stripView.holdsStill = false
                self.endReveal(panel)
                panel.tearDown()
                panel.removeFromSuperview()
                self.recordingPanel = nil
            }
            guard travels else {
                endReveal(panel)
                fade(in: [stripView, dictationKey] + (engine.layout.agentKey == nil ? [] : [agentKey]), out: [panel],
                     duration: animated ? StripMotion.reducedFade : 0, after: finish)
                return
            }
            stripView.isHidden = false
            stripView.alpha = 1
            let fresh = beginReveal(panel)
            if fresh {
                UIView.performWithoutAnimation { placeReveal(open: true, panel: panel) }
            }
            if dictationKey.isHidden || dictationKey.alpha == 0 {
                dictationKey.isHidden = false
                dictationKey.transform = voiceKeyTucked
            }
            agentKey.isHidden = engine.layout.agentKey == nil
            StripMotion.animate(StripMotion.shrink, fresh: fresh, {
                self.placeReveal(open: false, panel: panel)
            }, completion: { _ in finish() })
            StripMotion.animate(StripMotion.settleExit) { panel.setControls(shown: false) }
            StripMotion.animate(StripMotion.settle) {
                self.dictationKey.alpha = 1
                self.dictationKey.transform = .identity
                self.agentKey.alpha = 1
            }
        }
    }

    /// The Dictation key a little smaller about its keycap's centre, as it leaves and returns.
    private var voiceKeyTucked: CGAffineTransform {
        let s = StripMotion.controlScale
        let cap = dictationKey.keycapFrame
        let dx = cap.midX - dictationKey.bounds.midX
        let dy = cap.midY - dictationKey.bounds.midY
        return CGAffineTransform(translationX: dx, y: dy).scaledBy(x: s, y: s).translatedBy(x: -dx, y: -dy)
    }

    /// Masks the words and the dots on the two sides of one soft edge. True when they were
    /// unmasked, so the edge starts at home in the Dictation key; false mid-flight, where it carries on.
    private func beginReveal(_ panel: VoiceRecordingPanel) -> Bool {
        let dotsAfter = !engine.layout.voiceKeyOnLeading
        if let wordsMask, wordsMask.opaqueAfter == !dotsAfter, panel.dotsMask?.opaqueAfter == dotsAfter {
            return false
        }
        let words = StripRevealMask(opaqueAfter: !dotsAfter)
        let dots = StripRevealMask(opaqueAfter: dotsAfter)
        stripView.mask = words
        wordsMask = words
        panel.dotsMask = dots
        UIView.performWithoutAnimation { placeReveal(open: false, panel: panel) }
        return true
    }

    private func endReveal(_ panel: VoiceRecordingPanel) {
        stripView.mask = nil
        wordsMask = nil
        panel.dotsMask = nil
    }

    /// Where the edge's band starts (it is `StripRevealMask.feather` wide): home, at the Dictation key's
    /// side of the bar with every dot gathered in and every word shown, or across the bar.
    private func placeReveal(open: Bool, panel: VoiceRecordingPanel) {
        let well = panel.convert(panel.wellFrame, to: self)
        let words = stripView.frame
        let feather = StripRevealMask.feather
        let band: CGFloat = if engine.layout.voiceKeyOnLeading {
            open ? max(well.maxX, words.maxX) : min(well.minX, words.minX) - feather
        } else {
            open ? min(well.minX, words.minX) - feather : max(well.maxX, words.maxX)
        }
        wordsMask?.place(bandStart: band - words.minX)
        panel.dotsMask?.place(bandStart: band - well.minX)
    }

    /// Where the recording panel sits: the suggestion strip, full width and its height, so
    /// neither the keyboard nor the keys move.
    var recordingPanelFrame: CGRect {
        let m = engine.layout.metrics
        return CGRect(x: 0, y: m.stripTop + appliedLift, width: bounds.width, height: m.stripHeight)
    }

    private func fade(
        in shown: [UIView],
        out hidden: [UIView],
        duration requested: TimeInterval = 0.2,
        delay: TimeInterval = 0,
        after: (() -> Void)? = nil
    ) {
        shown.forEach { $0.isHidden = false }
        let globeHidden = engine.layout.key(.globe) == nil
        let accentHidden = engine.activeAccentMenu == nil
        let duration = window == nil ? 0 : requested
        if duration == 0 {
            shown.forEach { $0.alpha = 1 }
            hidden.forEach {
                $0.alpha = 0
                $0.isHidden = true
            }
            if globeHidden { globeButton.isHidden = true }
            if accentHidden { accentCallout.isHidden = true }
            after?()
            return
        }
        UIView.animate(springDuration: duration, bounce: 0, initialSpringVelocity: 0, delay: delay * MotionDebug.slow, options: [.beginFromCurrentState, .allowUserInteraction]) {
            shown.forEach { $0.alpha = 1 }
            hidden.forEach { $0.alpha = 0 }
        } completion: { _ in
            // A Dictation key still held for push to talk stays in the window (at alpha 0), so its
            // touch keeps arriving and lifting the finger finishes the dictation.
            for view in hidden where view.alpha == 0 && (view as? UIControl)?.isTracking != true {
                view.isHidden = true
            }
            if globeHidden { self.globeButton.isHidden = true }
            if accentHidden { self.accentCallout.isHidden = true }
            after?()
        }
    }
}
