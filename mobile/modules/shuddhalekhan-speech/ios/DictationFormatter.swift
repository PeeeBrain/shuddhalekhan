import Foundation

struct DictationVocabulary {
  private static let word = try! NSRegularExpression(pattern: #"[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*"#)
  private static let separator = try! NSRegularExpression(pattern: #"^(?:[ \t]+|[ \t]*-[ \t]*)$"#)
  private let terms: [String: String]
  private let longest: Int

  init(_ entries: [String]) {
    var terms: [String: String] = [:]
    var longest = 0
    for entry in entries {
      guard let words = Self.termWords(entry) else { continue }
      terms[words.joined(separator: " ")] = entry
      longest = max(longest, words.count)
    }
    self.terms = terms
    self.longest = longest
  }

  static func validated(_ entries: [String]) -> [String]? {
    guard entries.count <= 100 else { return nil }
    var keys = Set<String>()
    let trimmed = entries.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    for entry in trimmed {
      guard entry.utf8.count <= 256, entry.count <= 64, let words = termWords(entry),
            keys.insert(words.joined(separator: " ")).inserted else { return nil }
    }
    return trimmed
  }

  private static func termWords(_ string: String) -> [String]? {
    let text = string as NSString
    let words = Self.word.matches(in: string, range: NSRange(location: 0, length: text.length))
    guard let first = words.first, let last = words.last, first.range.location == 0,
          NSMaxRange(last.range) == text.length else { return nil }
    for (previous, next) in zip(words, words.dropFirst()) {
      guard joins(text, previous.range, next.range) else { return nil }
    }
    return words.map { key(text.substring(with: $0.range)) }
  }

  private static func joins(_ text: NSString, _ first: NSRange, _ second: NSRange) -> Bool {
    let end = NSMaxRange(first)
    let length = second.location - end
    // Bound each candidate gap before trying the expression on long input.
    guard (1...64).contains(length) else { return false }
    let gap = text.substring(with: NSRange(location: end, length: length))
    return separator.firstMatch(in: gap, range: NSRange(location: 0, length: length)) != nil
  }

  private static func key(_ word: String) -> String {
    word.precomposedStringWithCanonicalMapping.lowercased().replacingOccurrences(of: "’", with: "'")
  }

  func apply(to string: String) -> String {
    guard longest > 0 else { return string }
    let text = string as NSString
    let words = Self.word.matches(in: string, range: NSRange(location: 0, length: text.length))
    var output = ""
    var cursor = 0
    var index = 0
    while index < words.count {
      var prefix = ""
      var match: (end: Int, replacement: String)?
      for end in index..<min(index + longest, words.count) {
        if end > index, !Self.joins(text, words[end - 1].range, words[end].range) { break }
        let original = text.substring(with: words[end].range)
        let word = Self.key(original)
        guard prefix.utf8.count + word.utf8.count <= 258 else { break }
        if let term = terms[prefix + word] {
          match = (end, term)
        } else if word.hasSuffix("'s"), let term = terms[prefix + word.dropLast(2)] {
          match = (end, term + original.suffix(2))
        }
        prefix += word + " "
      }
      guard let match else { index += 1; continue }
      let start = words[index].range.location
      output += text.substring(with: NSRange(location: cursor, length: start - cursor))
      output += match.replacement
      cursor = NSMaxRange(words[match.end].range)
      index = match.end + 1
    }
    return output + text.substring(from: cursor)
  }
}

enum DictationFormatter {
  private static let filler = try! NSRegularExpression(pattern: #"(?i)(?<![\p{L}\p{M}\p{N}'’])(?:um+|uh+)(?![\p{L}\p{M}\p{N}'’])[ \t]*,?[ \t]*"#)
  private static let notes = try! NSRegularExpression(pattern: #"(?i)[ \t]{0,64}(?<![\p{L}\p{M}\p{N}'’])(new paragraph|new line|bullet)(?![\p{L}\p{M}\p{N}'’])[,.:]?[ \t]*"#)
  private static let sentenceStart = try! NSRegularExpression(pattern: #"(?:^|[.!?][ \t]+|\n+)[ \t„“"'‘(]*([a-z])"#)
  private static let closers: Set<Character> = ["”", "’", "\"", "'", ")", "]", "}", "»"]

  static func style(_ text: String, as style: DictationStyle, language: String) -> String {
    guard style != .legacy else { return text }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let english = language.lowercased().split(separator: "-").first == "en"
    switch style {
    case .legacy, .verbatim: return trimmed
    case .casual:
      // Keep the recognizer's casing and internal punctuation, including abbreviations.
      guard english, trimmed.last == ".", trimmed.dropLast().suffix(3).allSatisfy(\.isLetter),
            trimmed.count > 3 else { return trimmed }
      return String(trimmed.dropLast())
    case .notes:
      guard english else { return trimmed }
      return replace(notes, in: trimmed) { match, phrase in
        switch phrase.lowercased() {
        case "new paragraph": return "\n\n"
        case "new line": return "\n"
        default: return (match.range.location == 0 ? "" : "\n") + "• "
        }
      }.replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    case .polished:
      guard english else { return trimmed }
      let clean = filler.stringByReplacingMatches(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed), withTemplate: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
      let capitalized = replace(sentenceStart, in: clean) { _, letter in letter.uppercased() }
      let punctuation = capitalized.reversed().prefix { closers.contains($0) }
      let body = capitalized.dropLast(punctuation.count)
      guard let end = body.last, end.isLetter || end.isNumber else { return capitalized }
      return String(body) + "." + String(punctuation.reversed())
    }
  }

  private static func replace(
    _ regex: NSRegularExpression, in text: String, with replacement: (NSTextCheckingResult, String) -> String
  ) -> String {
    let source = text as NSString
    let result = NSMutableString(string: text)
    for match in regex.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
      let range = regex == sentenceStart ? match.range(at: 1) : match.range
      result.replaceCharacters(in: range, with: replacement(match, source.substring(with: match.range(at: 1))))
    }
    return result as String
  }
}
