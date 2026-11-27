import Foundation

enum DictationCleanupGuard {
  private static let tokens = try! NSRegularExpression(pattern: #"[\p{L}\p{M}\p{N}]+(?:['’.,-][\p{L}\p{M}\p{N}]+)*|[\p{Sc}%‰=<>±+−/⁄∕*×÷-]"#)

  static func accepts(_ candidate: String, replacing original: String) -> Bool {
    guard !candidate.isEmpty, candidate.utf8.count <= original.utf8.count + 24 else { return false }
    let before = words(original)
    let after = words(candidate)
    guard !after.isEmpty else { return false }
    if before == after { return true }
    // Only leading English filler can disappear. Match remaining words exactly, including names and numbers.
    let stripped = before.drop(while: { $0 == "um" || $0 == "uh" })
    return before.count - stripped.count <= 3 && stripped.elementsEqual(after)
  }

  private static func words(_ text: String) -> [String] {
    let text = text.precomposedStringWithCanonicalMapping
    let source = text as NSString
    return tokens.matches(in: text, range: NSRange(location: 0, length: source.length))
      .map { source.substring(with: $0.range) }
  }
}
