import Foundation

enum DictationStyle: String, Codable, CaseIterable, Sendable {
  case legacy, polished, casual, notes, verbatim

  var title: String { self == .legacy ? "Original" : rawValue.capitalized }
}
