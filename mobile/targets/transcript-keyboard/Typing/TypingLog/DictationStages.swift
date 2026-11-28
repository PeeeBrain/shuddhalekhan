// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXShared/TypingLog/DictationStages.swift at f38e9fc.
// See Typing/NOTICE.md.

import Foundation

/// What each step of a dictation made of the words, for Record typing logs. The keyboard sends it
/// with the result (`KeyboardSnapshot.stages`) only while the experiment is on; a step that
/// didn't run is nil.
nonisolated struct DictationStages: Codable, Equatable, Sendable {
    var engine: String?
    /// The speech locale's identifier, when known (in-keyboard dictation).
    var locale: String?
    /// The transcription language as the keyboard shows it (the app).
    var language: String?
    var style: String?
    /// How long it recorded.
    var recordedMS: Int?
    /// From the end of recording to the finished text.
    var transcribeMS: Int?
    /// As the speech model heard it.
    var raw: String?
    /// After Learn how I type's dictation fixes.
    var fixed: String?
    /// After custom vocabulary's spelling (the app).
    var spelled: String?
    /// After Clean up what I say; nil while it is off.
    var tagged: String?
    /// After Clean up with Apple Intelligence; nil while it is off (the app).
    var cleaned: String?
    var translated: String?
    /// After the style's formatting and spelling again (the app).
    var formatted: String?
}
