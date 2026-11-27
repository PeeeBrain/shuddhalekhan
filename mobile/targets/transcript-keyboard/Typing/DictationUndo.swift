// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXShared/FullKeyboard/DictationUndo.swift at f38e9fc.
// See Typing/NOTICE.md.

import Foundation

/// The dictation Undo can take back. Shuddhalekhan keeps its own rule here rather than Hex's search from
/// wherever the cursor moved: a host shows only a window of the field, so an earlier copy of the same words
/// can look exactly like the dictation. Undo is offered only when the host confirms the dictation went in
/// at the cursor, and works only while the cursor is still there with the same text either side.
struct DictationUndo: Equatable {
    let text: String
    /// What the host showed before and after the cursor right after the dictation went in.
    let before: String
    let after: String

    /// Nil unless the host shows `text` went in at the cursor: the text before it changed, ends with
    /// `text`, and is the end of what was there plus `text` (hosts show a window); the text after it
    /// is unchanged.
    init?(text: String, before: String, after: String, resultingBefore: String, resultingAfter: String) {
        guard !text.isEmpty, resultingAfter == after, resultingBefore != before,
              resultingBefore.hasSuffix(text), (before + text).hasSuffix(resultingBefore)
        else { return nil }
        self.text = text
        self.before = resultingBefore
        self.after = after
    }

    /// Whether deleting `text.count` characters before the cursor takes back exactly the dictation.
    func matches(before current: String, after following: String, selected: String?) -> Bool {
        (selected?.isEmpty ?? true) && current == before && following == after
    }
}
