// Controlled UIKit assertions for checking the real publication lifetime without an iPhone.
public struct UIBackgroundTaskIdentifier: Equatable, Sendable {
  public let rawValue: Int
  public static let invalid = UIBackgroundTaskIdentifier(rawValue: -1)
}

@MainActor
public final class UIApplication {
  public static let shared = UIApplication()
  public enum State { case active, background }
  public var applicationState = State.background
  public var grantsBackgroundTime = true
  public private(set) var activeTasks = 0
  public private(set) var requests = 0
  public var expirationHandler: (@MainActor @Sendable () -> Void)?

  public func beginBackgroundTask(withName: String?, expirationHandler: (@MainActor @Sendable () -> Void)?) -> UIBackgroundTaskIdentifier {
    requests += 1
    guard grantsBackgroundTime else { return .invalid }
    activeTasks += 1
    self.expirationHandler = expirationHandler
    return UIBackgroundTaskIdentifier(rawValue: requests)
  }

  public func endBackgroundTask(_ identifier: UIBackgroundTaskIdentifier) {
    precondition(identifier != .invalid && activeTasks > 0, "A publication assertion must be ended exactly once")
    activeTasks -= 1
  }
}
