import Foundation
import Network

// This check exercises listener ownership only. The separate KeyboardBridgeCheck owns actual TCP delivery.
@MainActor
final class KeyboardSessionChannel {
  var onMessage: (Data) -> Void = { _ in }
  var onClose: () -> Void = {}
  init(_ connection: NWConnection, maxBytes: Int) { preconditionFailure("No peer should connect in this check") }
  func start() {}
  func close() {}
  func send<T: Encodable>(_ value: T, closeAfter: Bool = false) {}
}

@main
struct ListenerStartupCheck {
  @MainActor static func main() async throws {
    let watchdog = Task {
      try await Task.sleep(for: .seconds(10))
      preconditionFailure("ListenerStartupCheck timed out")
    }
    defer { watchdog.cancel() }
    let server = KeyboardSessionServer()
    var failures = 0
    server.onFailure = { failures += 1 }
    let firstStart = Task { try await server.start(expiresAt: KeyboardSession.nowMs() + 60_000) }
    let first = await NWListener.nextStarted()
    first.deliverQueued(.ready)
    _ = try await firstStart.value
    server.stop()

    let secondStart = Task { try await server.start(expiresAt: KeyboardSession.nowMs() + 60_000) }
    let second = await NWListener.nextStarted()
    // Deliver an already queued callback even though stop cleared the old listener's installed handler.
    first.deliverQueued(.failed(NWError()))
    precondition(failures == 0, "Old listener failure reached the replacement startup")
    second.deliverQueued(.ready)
    _ = try await secondStart.value

    // The current listener's failure must still be reported.
    second.deliverQueued(.failed(NWError()))
    precondition(failures == 1, "Current listener failure was ignored")
    server.stop()
    print("ListenerStartupCheck passed: stale failure during replacement startup, current failure delivery")
  }
}
