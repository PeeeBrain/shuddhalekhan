import Foundation

enum ParakeetModel: Sendable { case english, multilingual }

struct ParakeetConfiguration: Sendable {
  let language: String
  var model: ParakeetModel { language == "en" ? .english : .multilingual }

  init(language: String) throws {
    let base = language.lowercased().split(separator: "-").first.map(String.init) ?? ""
    guard base.isEmpty || Self.supported.contains(base) else {
      throw ConfigurationError.unsupportedLanguage
    }
    self.language = base
  }

  private static let supported: Set<String> = [
    "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
    "lv", "lt", "mt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "uk"
  ]

  private enum ConfigurationError: LocalizedError {
    case unsupportedLanguage
    var errorDescription: String? { "Parakeet does not support this language. Choose a supported language or use an endpoint." }
  }
}
