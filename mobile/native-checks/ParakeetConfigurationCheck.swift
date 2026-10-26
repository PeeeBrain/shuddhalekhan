import Foundation

// Run by scripts/build-ios.sh on macOS: swiftc ParakeetConfiguration.swift ParakeetConfigurationCheck.swift.
@main
struct ParakeetConfigurationCheck {
  static func main() {
    // Explicit English, including regional variants, uses the English-only v2 model.
    for language in ["en", "en-IN", "EN-gb"] {
      let configuration = try! ParakeetConfiguration(language: language)
      precondition(configuration.model == .english && configuration.language == "en", language)
    }
    // Other supported languages and Auto-detect use v3; the hint is the base language, or none.
    precondition(try! ParakeetConfiguration(language: "pt-BR").model == .multilingual)
    precondition(try! ParakeetConfiguration(language: "pt-BR").language == "pt")
    precondition(try! ParakeetConfiguration(language: "").model == .multilingual)
    precondition(try! ParakeetConfiguration(language: "").language == "")
    // Languages Parakeet lacks fail instead of silently transcribing as another language.
    for language in ["hi", "mr", "ja"] {
      precondition((try? ParakeetConfiguration(language: language)) == nil, language)
    }
    print("Parakeet configuration checks passed.")
  }
}
