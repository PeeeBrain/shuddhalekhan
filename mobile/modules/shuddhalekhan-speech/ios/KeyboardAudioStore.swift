import Foundation
import OSLog

/// Failed deletions stay pending; another utterance cannot add more audio until cleanup succeeds.
@MainActor
final class KeyboardAudioStore {
  private let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("keyboard-recordings", isDirectory: true)
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "KeyboardBridge")
  private var pending = Set<URL>()

  init() {
    do {
      pending = Set(try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil))
      for url in pending { remove(url) }
    } catch CocoaError.fileReadNoSuchFile {
      // No recordings have been created yet.
    } catch {
      log.error("KeyboardBridge could not inspect temporary audio for cleanup")
    }
  }

  func recordingURL() throws -> URL {
    for url in pending { remove(url) }
    guard pending.isEmpty else { throw CleanupError.pendingAudio }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent("\(UUID().uuidString).caf")
  }

  func remove(_ url: URL) {
    pending.insert(url)
    do {
      try FileManager.default.removeItem(at: url)
      pending.remove(url)
    } catch CocoaError.fileNoSuchFile {
      pending.remove(url)
    } catch {
      log.error("KeyboardBridge temporary audio deletion failed; cleanup will retry before recording")
    }
  }

  private enum CleanupError: LocalizedError {
    case pendingAudio
    var errorDescription: String? { "Temporary audio could not be deleted. Free storage or restart the app before recording again." }
  }
}
