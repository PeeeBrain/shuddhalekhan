import UIKit

// An audio session keeps JS alive, but ActivityKit requires a non-audio background assertion.
@MainActor
final class ActivityPublication {
  private var identifier: UIBackgroundTaskIdentifier = .invalid

  init() {
    guard UIApplication.shared.applicationState != .active else { return }
    identifier = UIApplication.shared.beginBackgroundTask(withName: "Agent activity publication") { [weak self] in
      self?.end()
    }
  }

  func end() {
    guard identifier != .invalid else { return }
    let finished = identifier
    identifier = .invalid
    UIApplication.shared.endBackgroundTask(finished)
  }
}
