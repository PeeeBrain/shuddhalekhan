import ActivityKit
import Foundation

struct SystemDictationAttributes: ActivityAttributes {
  enum Phase: String, Codable, Hashable, Sendable {
    case preparing, recording, transcribing, copied, ready, failed, cancelled

    var title: String {
      switch self {
      case .preparing: "Preparing microphone"
      case .recording: "Recording dictation"
      case .transcribing: "Transcribing"
      case .copied: "Copied to clipboard"
      case .ready: "Open Shuddhalekhan to copy"
      case .failed: "Dictation failed"
      case .cancelled: "Dictation cancelled"
      }
    }
  }

  /// `startedAt` rides along with `.recording` so the widget can count the elapsed time without updates.
  struct ContentState: Codable, Hashable, Sendable {
    let phase: Phase
    var startedAt: Date? = nil
  }

  let requestID: String
}
