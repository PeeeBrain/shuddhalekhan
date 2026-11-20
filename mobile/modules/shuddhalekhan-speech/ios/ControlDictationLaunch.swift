@MainActor
enum ControlDictationLaunch {
  private static var pending: ContinuousClock.Instant?
  static var onRequest: (() -> Void)?

  static func request() {
    pending = .now
    onRequest?()
  }

  static func consume() -> Bool {
    defer { pending = nil }
    guard let pending else { return false }
    return pending.duration(to: .now) < .seconds(15)
  }
}
