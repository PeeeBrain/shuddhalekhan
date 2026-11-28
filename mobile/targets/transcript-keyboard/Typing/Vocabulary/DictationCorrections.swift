// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXShared/DictationCorrections.swift at f38e9fc.
// See Typing/NOTICE.md.

import Foundation

/// One learned dictation fix: words the speech model keeps getting wrong, and what you meant.
nonisolated struct DictationCorrection: Equatable, Sendable {
    let heard: String
    let meant: String
}

/// A learned dictation fix as Typing insights shows it.
nonisolated struct DictationLearnedFix: Equatable, Sendable, Identifiable {
    var id: String
    var heard: String
    var meant: String
    var count: Int
    var contradictions: Int

    var correction: DictationCorrection { DictationCorrection(heard: heard, meant: meant) }
}

/// When a (heard → meant) substitution becomes a fix the keyboard applies.
nonisolated enum DictationLearningRule {
    static let minimumCount = 2

    /// Every substitution you made (by editing or dictating again), grouped by heard
    /// words and meant words ignoring case. A capital you used is kept as the spelling.
    static func candidates(from records: [TypingJournalDictationFix]) -> [DictationLearnedFix] {
        var groups: [String: DictationLearnedFix] = [:]
        var order: [String] = []
        for record in records where record.kind == .substituted || record.kind == .redictated {
            let heardKey = DictationText.phraseKey(record.heard)
            let meantKey = DictationText.phraseKey(record.meant)
            guard !heardKey.isEmpty, !meantKey.isEmpty, record.meant != record.heard else { continue }
            let id = heardKey + " → " + meantKey
            var group = groups[id] ?? DictationLearnedFix(id: id, heard: heardKey, meant: record.meant, count: 0, contradictions: 0)
            if groups[id] == nil { order.append(id) }
            group.count += record.count
            group.contradictions += record.contradictions
            if record.meant.contains(where: \.isUppercase) { group.meant = record.meant }
            groups[id] = group
        }
        return order.compactMap { groups[$0] }
    }

    /// Fixes seen at least twice, never contradicted, and whose heard words you only ever
    /// fixed one way. Anything else stays a record and is never applied.
    static func learned(from records: [TypingJournalDictationFix]) -> [DictationLearnedFix] {
        let all = candidates(from: records)
        var meanings: [String: Int] = [:]
        for fix in all { meanings[fix.heard, default: 0] += 1 }
        return all.filter { fix in
            fix.count >= minimumCount && fix.contradictions == 0 && meanings[fix.heard] == 1
        }
    }
}
