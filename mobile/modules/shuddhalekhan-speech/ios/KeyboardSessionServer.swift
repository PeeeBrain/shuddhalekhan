import Foundation
import Network
import OSLog
import Security

/// Only listens on 127.0.0.1, with a fresh 256-bit secret per microphone session. No LAN, HTTP, or Bonjour.
@MainActor
final class KeyboardSessionServer {
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "KeyboardBridge")
  private var listener: NWListener?
  private var ready: CheckedContinuation<KeyboardSession.Bridge, Error>?
  private var clients: [UUID: KeyboardSessionChannel] = [:]
  private var authenticated = Set<UUID>()
  private var owners: [UUID: String] = [:]
  private var token = ""
  private var expiresAt: Int64 = 0
  private var state = KeyboardSession.State.ended
  var onCommand: (KeyboardSession.Command) -> Void = { _ in }
  var onFailure: () -> Void = {}

  func start(expiresAt: Int64) async throws -> KeyboardSession.Bridge {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw CocoaError(.coderInvalidValue)
    }
    token = Data(bytes).base64EncodedString()
    self.expiresAt = expiresAt
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    return try await withCheckedThrowingContinuation { continuation in
      ready = continuation
      listener.stateUpdateHandler = { [weak self] status in
        MainActor.assumeIsolated {
          guard let self else { return }
          switch status {
          case .ready:
            guard let port = self.listener?.port, let pending = self.ready else { return }
            self.ready = nil
            self.log.notice("KeyboardBridge listener ready")
            pending.resume(returning: .init(port: port.rawValue, token: self.token, expiresAt: self.expiresAt))
          case .failed(let error):
            self.ready?.resume(throwing: error)
            self.ready = nil
            self.log.error("KeyboardBridge listener failed")
            self.onFailure()
          default: break
          }
        }
      }
      listener.newConnectionHandler = { [weak self] connection in
        MainActor.assumeIsolated { self?.accept(connection) }
      }
      listener.start(queue: .main)
      Task { @MainActor [weak self] in
        try? await Task.sleep(for: .seconds(5))
        guard let self, let pending = self.ready else { return }
        self.ready = nil
        pending.resume(throwing: CocoaError(.fileReadUnknown))
        self.stop()
      }
    }
  }

  func publish(_ state: KeyboardSession.State) {
    self.state = state
    for id in authenticated { clients[id]?.send(state) }
  }

  func stop(final: KeyboardSession.State? = nil) {
    ready?.resume(throwing: CancellationError())
    ready = nil
    listener?.cancel()
    listener = nil
    let closing = clients
    clients.removeAll()
    let allowed = authenticated
    authenticated.removeAll()
    owners.removeAll()
    for (id, client) in closing {
      if let final, allowed.contains(id) { client.send(final, closeAfter: true) } else { client.close() }
    }
  }

  private func accept(_ connection: NWConnection) {
    guard clients.count < 4 else { connection.cancel(); return }
    let id = UUID()
    let client = KeyboardSessionChannel(connection, maxBytes: 2_000)
    clients[id] = client
    client.onMessage = { [weak self, weak client] data in
      guard let self, let client else { return }
      guard let request = KeyboardSession.decodeRequest(data, token: self.token, now: KeyboardSession.nowMs()) else {
        self.log.error("KeyboardBridge rejected unauthenticated or invalid request")
        client.close()
        return
      }
      if self.authenticated.insert(id).inserted { self.log.notice("KeyboardBridge keyboard authenticated") }
      if let command = request.command {
        // A peer can stop only its own utterance, including on disconnect.
        if command.action != .start && self.owners[id] != command.id { return client.send(self.state) }
        if command.action == .start && !self.state.isBusy { self.owners[id] = command.id }
        self.log.notice("KeyboardBridge command \(command.action.rawValue, privacy: .public)")
        let previousState = self.state
        self.onCommand(command)
        // A transition already published its acknowledgement to every authenticated peer.
        if self.state != previousState { return }
      }
      client.send(self.state)
    }
    client.onClose = { [weak self] in
      guard let self else { return }
      self.clients[id] = nil
      self.authenticated.remove(id)
      if let requestId = self.owners.removeValue(forKey: id) {
        self.onCommand(.init(id: requestId, action: .cancel, sentAt: KeyboardSession.nowMs()))
      }
    }
    client.start()
    Task { @MainActor [weak self, weak client] in
      try? await Task.sleep(for: .seconds(3))
      if self?.authenticated.contains(id) != true { client?.close() }
    }
  }
}
