import Combine
import UIKit

/// What Hex's full keyboard (`FullKeyboardView`) reads and calls, backed by Shuddhalekhan's keyboard
/// session: `KeyboardViewController` sets the state from the session's snapshots and does the work
/// behind the callbacks. Levels skip this model (`FullKeyboardView.pushLevel`) so 15 readings a
/// second don't refresh the whole keyboard.
@MainActor
final class KeyboardViewModel: ObservableObject {
  /// The keyboard's request as the strip shows it: the recording panel while starting, recording
  /// or transcribing, the words otherwise.
  enum StagePhase { case idle, starting, recording, transcribing }

  @Published var hasFullAccess = false
  @Published var needsGlobeKey = true
  @Published var stagePhase = StagePhase.idle
  /// Which request is in flight: the panel's dot colour and shape, and what ✓ says.
  @Published var mode = KeyboardSession.Mode.dictate
  /// The session's dictation style, ticked in the Dictation key's menu.
  @Published var style: DictationStyle?
  /// One line in the strip from the session: connecting, a failure, Sent to the agent.
  @Published var notice: String?

  var onStart: ((KeyboardSession.Mode) -> Void)?
  var onStop: (() -> Void)?
  var onCancel: (() -> Void)?
  var onStyleSelected: ((DictationStyle) -> Void)?
  var onDismissNotice: (() -> Void)?
}

/// Hex keeps the keyboard's settings, learned words and clipboard state in its App Group's defaults.
/// Shuddhalekhan has no App Group (free Apple ID signing), so this suite resolves to the keyboard's
/// own defaults and container-only features (typing journal, typing logs) stay off.
enum KeyboardBridge {
  static let appGroup = "group.com.shuddhalekhan.mobile.keyboard"
}
