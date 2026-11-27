// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXShared/FullKeyboard/View/FullKeyboardView+Settings.swift at f38e9fc.
// See Typing/NOTICE.md.

import UIKit

/// The keyboard's key layout settings (Settings › Keyboard and Settings › Labs),
/// applied on every sync: where the Dictation key sits, the number row, and whether the Duo unfolded
/// draws one keyboard. Switches that only change typing behaviour stay in
/// `FullKeyboardView.syncSettings`.
@MainActor
extension FullKeyboardView {
    /// The Dictation key at the strip's trailing end (the Agent key takes its leading end),
    /// kept in `VoiceKeyPlacement.current` too for typing logs.
    func syncVoicePlacement() {
        let placement = voicePlacementOverride ?? .stripTrailing
        VoiceKeyPlacement.current = placement
        guard engine.voicePlacement != placement else { return }
        plane.cancelAllTouches()
        dismissStyleMenu()
        engine.voicePlacement = placement
        setNeedsLayout()
    }

    /// Settings › Keyboard › Number row: the keyboard grows by the row, so the host is asked
    /// for the new height. Settings › Keyboard › Key flicks (iPad) is read here too.
    func syncNumberRow() {
        let flicks = FullKeyboardSettings().keyFlicks
        if KeyboardFlicks.isEnabled != flicks {
            KeyboardFlicks.isEnabled = flicks
            plane.setNeedsDisplay()
        }
        let shows = FullKeyboardSettings().numberRow
        guard engine.showsNumberRow != shows else { return }
        plane.cancelAllTouches()
        dismissStyleMenu()
        engine.showsNumberRow = shows
        setNeedsLayout()
        onPreferredHeightChange?()
    }

    /// Settings › Labs › Join the keyboard when unfolded: the Duo unfolded upright draws
    /// one keyboard rather than the split one. The rows keep their heights, so the host is asked
    /// for nothing.
    func syncJoinsUnfoldedKeyboard() {
        let joins = FullKeyboardSettings().joinsKeyboardWhenUnfolded
        guard engine.joinsUnfoldedKeyboard != joins else { return }
        plane.cancelAllTouches()
        dismissStyleMenu()
        engine.joinsUnfoldedKeyboard = joins
        setNeedsLayout()
    }

    /// Settings › Labs › Dvorak punctuation keys: English's Dvorak letters gain comma,
    /// period and semicolon keys. No row changes height, so the host is asked for nothing.
    func syncDvorakPunctuation() {
        let on = FullKeyboardSettings().dvorakPunctuation
        guard engine.dvorakPunctuation != on else { return }
        plane.cancelAllTouches()
        dismissStyleMenu()
        engine.dvorakPunctuation = on
        setNeedsLayout()
    }

    /// Settings › Labs › Comma and period keys: a comma and a period join the space bar
    /// on an iPhone's letters page in a text field. No row changes height, so the host is asked
    /// for nothing.
    func syncCommaPeriodKeys() {
        let on = FullKeyboardSettings().commaPeriodKeys
        guard engine.commaPeriodKeys != on else { return }
        plane.cancelAllTouches()
        dismissStyleMenu()
        engine.commaPeriodKeys = on
        setNeedsLayout()
    }
}
