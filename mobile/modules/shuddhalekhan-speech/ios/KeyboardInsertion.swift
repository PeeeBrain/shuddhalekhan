import Foundation

enum KeyboardInsertion {
  private static let closingPunctuation: Set<Character> = [".", ",", "!", "?", ";", ":", ")", "]", "}", "…", "”", "’", "%"]
  private static let openingPunctuation: Set<Character> = ["(", "[", "{", "“", "‘"]

  static func text(_ transcript: String, before: String?, after: String?) -> String {
    guard let first = transcript.first, let last = transcript.last else { return transcript }
    let leading = before?.last.map { needsSpace(between: $0, and: first) } ?? false
    let trailing = after?.first.map { needsSpace(between: last, and: $0) } ?? false
    return (leading ? " " : "") + transcript + (trailing ? " " : "")
  }

  private static func needsSpace(between left: Character, and right: Character) -> Bool {
    guard !left.isWhitespace, !right.isWhitespace, !openingPunctuation.contains(left),
          !closingPunctuation.contains(right), left != "'", right != "'", left != "\"", right != "\"" else {
      return false
    }
    // Scripts that normally omit word spaces should remain adjacent.
    let spaced = { (character: Character) in
      (character.isLetter || character.isNumber) && character.unicodeScalars.allSatisfy {
        switch $0.value {
        case 0x3040...0x30FF, 0x3400...0x9FFF, 0xF900...0xFAFF, 0x20000...0x323AF: return false
        default: return true
        }
      }
    }
    return (spaced(left) || closingPunctuation.contains(left)) &&
      (spaced(right) || openingPunctuation.contains(right))
  }
}
