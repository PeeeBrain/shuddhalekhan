import Foundation
import Network

@MainActor
private final class Peer {
  let channel: KeyboardSessionChannel
  let token: String
  var states: [KeyboardSession.State] = []
  var waiting: (KeyboardSession.State.Phase, CheckedContinuation<KeyboardSession.State, Never>)?

  init(_ bridge: KeyboardSession.Bridge) {
    token = bridge.token
    channel = KeyboardSessionChannel(
      NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: bridge.port)!, using: .tcp),
      maxBytes: KeyboardSession.maxTextBytes * 7)
    channel.onOpen = { [weak self] in self?.send(nil) }
    channel.onMessage = { [weak self] data in
      guard let self else { return }
      guard let state = KeyboardSession.decodeState(data) else { preconditionFailure("Invalid response") }
      self.states.append(state)
      if let (phase, continuation) = self.waiting, state.phase == phase {
        self.waiting = nil
        continuation.resume(returning: state)
      }
    }
  }

  func send(_ command: KeyboardSession.Command?) {
    channel.send(KeyboardSession.Request(token: token, command: command))
  }

  func phase(_ phase: KeyboardSession.State.Phase) async -> KeyboardSession.State {
    if let state = states.last, state.phase == phase { return state }
    return await withCheckedContinuation { waiting = (phase, $0) }
  }
}

@main
struct KeyboardBridgeCheck {
  @MainActor static func main() async throws {
    Task { @MainActor in
      try await Task.sleep(for: .seconds(15))
      preconditionFailure("KeyboardBridgeCheck timed out")
    }
    let server = KeyboardSessionServer()
    var state = KeyboardSession.State(sessionEndsAt: KeyboardSession.nowMs() + 60_000,
      requestId: nil, phase: .idle, text: nil, error: nil)
    var commands: [KeyboardSession.Command.Action] = []
    server.onCommand = { command in
      commands.append(command.action)
      if let next = KeyboardSession.transition(state, on: command, now: KeyboardSession.nowMs()) {
        state = next
        server.publish(next)
      }
    }
    let bridge = try await server.start(expiresAt: state.sessionEndsAt)
    server.publish(state)

    // Another local app cannot read state or start recording by guessing the port.
    let intruder = Peer(.init(port: bridge.port, token: String(repeating: "x", count: 44), expiresAt: bridge.expiresAt))
    await withCheckedContinuation { (closed: CheckedContinuation<Void, Never>) in
      intruder.channel.onClose = { closed.resume() }
      intruder.channel.start()
    }
    precondition(intruder.states.isEmpty && commands.isEmpty, "Unauthenticated peer reached the session")

    let peer = Peer(bridge)
    peer.channel.start()
    _ = await peer.phase(.idle)
    let id = UUID().uuidString
    peer.send(.init(id: id, action: .start, sentAt: KeyboardSession.nowMs()))
    let recording = await peer.phase(.recording)
    precondition(recording.requestId == id, "Start acknowledgement lost")
    peer.send(.init(id: id, action: .stop, sentAt: KeyboardSession.nowMs()))
    _ = await peer.phase(.transcribing)

    // A large transcript crosses multiple receive chunks and survives session expiry and connection close.
    let text = String(repeating: "hello ", count: 20_000)
    let final = KeyboardSession.State(sessionEndsAt: 0, requestId: id, phase: .done, text: text, error: nil)
    server.stop(final: final)
    let done = await peer.phase(.done)
    precondition(KeyboardSession.insertion(done, pendingId: id, inserted: []) == text, "Final result lost")
    precondition(KeyboardSession.insertion(done, pendingId: id, inserted: [id]) == nil, "Duplicate insertion")

    // Closing the keyboard cancels the utterance even if it disappears before the start acknowledgement.
    let second = KeyboardSessionServer()
    let bridge2 = try await second.start(expiresAt: bridge.expiresAt)
    let disappearing = Peer(bridge2)
    await withCheckedContinuation { (cancelled: CheckedContinuation<Void, Never>) in
      second.onCommand = { command in
        if command.action == .start { disappearing.channel.close() }
        if command.action == .cancel { cancelled.resume() }
      }
      disappearing.channel.onOpen = {
        disappearing.send(.init(id: "hidden", action: .start, sentAt: KeyboardSession.nowMs()))
      }
      disappearing.channel.start()
    }
    second.stop()
    precondition(commands == [.start, .stop], "Commands were dropped or replayed")
    print("KeyboardBridgeCheck passed: authentication, start/stop delivery, large final result, disconnect cancellation")
  }
}
