import AppIntents
#if canImport(ShuddhalekhanSpeech)
internal import ShuddhalekhanSpeech
#endif

@available(iOS 18.0, *)
struct DictateWithShuddhalekhan: AudioRecordingIntent, LiveActivityIntent {
  static let title: LocalizedStringResource = "Dictate with Shuddhalekhan"
  static let description = IntentDescription("Start or finish local dictation. Copy the result or open the app to retrieve it.")

  func perform() async throws -> some IntentResult & ProvidesDialog {
    #if canImport(ShuddhalekhanSpeech)
    let message = await SystemDictationActions.dictate()
    #else
    let message = "Open Shuddhalekhan to dictate."
    #endif
    return .result(dialog: IntentDialog(stringLiteral: message))
  }
}

struct FinishSystemDictation: LiveActivityIntent {
  static let title: LocalizedStringResource = "Finish Shuddhalekhan Dictation"

  @Parameter(title: "Recording ID") var requestID: String?

  init() {}
  init(requestID: String) { self.requestID = requestID }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    #if canImport(ShuddhalekhanSpeech)
    let message = await SystemDictationActions.finish(requestID: requestID)
    #else
    let message = "Open Shuddhalekhan to finish dictation."
    #endif
    return .result(dialog: IntentDialog(stringLiteral: message))
  }
}

struct CancelSystemDictation: LiveActivityIntent {
  static let title: LocalizedStringResource = "Cancel Shuddhalekhan Dictation"

  @Parameter(title: "Recording ID") var requestID: String?

  init() {}
  init(requestID: String) { self.requestID = requestID }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    #if canImport(ShuddhalekhanSpeech)
    let message = await SystemDictationActions.cancel(requestID: requestID)
    #else
    let message = "Open Shuddhalekhan to cancel dictation."
    #endif
    return .result(dialog: IntentDialog(stringLiteral: message))
  }
}

#if canImport(ShuddhalekhanSpeech)
struct StartKeyboardSessionIntent: AppIntent {
  static let title: LocalizedStringResource = "Start Shuddhalekhan Keyboard Session"
  static let openAppWhenRun = true

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let message = await SystemDictationActions.startKeyboard()
    return .result(dialog: IntentDialog(stringLiteral: message))
  }
}

struct StopKeyboardSessionIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Stop Shuddhalekhan Keyboard Session"

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let message = await SystemDictationActions.stopKeyboard()
    return .result(dialog: IntentDialog(stringLiteral: message))
  }
}

@available(iOS 18.0, *)
struct ShuddhalekhanShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: DictateWithShuddhalekhan(), phrases: ["Dictate with \(.applicationName)"],
      shortTitle: "Dictate", systemImageName: "mic")
    AppShortcut(intent: StartKeyboardSessionIntent(), phrases: ["Start keyboard session in \(.applicationName)"],
      shortTitle: "Start Keyboard Session", systemImageName: "keyboard")
    AppShortcut(intent: StopKeyboardSessionIntent(), phrases: ["Stop keyboard session in \(.applicationName)"],
      shortTitle: "Stop Keyboard Session", systemImageName: "stop.circle")
  }
}
#endif
