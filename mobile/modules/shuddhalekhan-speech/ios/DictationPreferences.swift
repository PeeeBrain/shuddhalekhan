import Foundation

struct DictationPreferences: Codable, Sendable {
  var style: DictationStyle
  var vocabularyEnabled = false
  var vocabulary: [String] = []
  var sessionMinutes = 10
  var cleanupEnabled = false

  func validated() throws -> Self {
    guard [5, 10, 15, 30].contains(sessionMinutes),
          let vocabulary = DictationVocabulary.validated(vocabulary) else {
      throw DictationPreferenceError.invalid
    }
    var value = self
    value.vocabulary = vocabulary
    return value
  }
}

enum DictationPreferenceError: LocalizedError {
  case invalid

  var errorDescription: String? {
    "Choose a valid session length and enter up to 100 distinct vocabulary terms of 1–64 characters."
  }
}

@MainActor
enum DictationSettings {
  static let key = "shuddhalekhan.dictation.preferences.v1"
  private static let languageKey = "shuddhalekhan.dictation.language"

  static var preferences: DictationPreferences {
    guard let data = UserDefaults.standard.data(forKey: key), data.count <= 32_768,
          let decoded = try? JSONDecoder().decode(DictationPreferences.self, from: data),
          let preferences = try? decoded.validated() else { return DictationPreferences(style: .legacy) }
    return preferences
  }

  static func initialize(existingInstall: Bool) throws -> DictationPreferences {
    if UserDefaults.standard.object(forKey: key) == nil {
      try save(DictationPreferences(style: existingInstall ? .legacy : .polished))
    }
    return preferences
  }

  static func save(_ preferences: DictationPreferences) throws {
    let value = try preferences.validated()
    UserDefaults.standard.set(try JSONEncoder().encode(value), forKey: key)
  }

  // Only the non-secret model language is needed when a Shortcut starts without React Native.
  static var language: String? {
    get { UserDefaults.standard.string(forKey: languageKey) }
    set { UserDefaults.standard.set(newValue, forKey: languageKey) }
  }
}
