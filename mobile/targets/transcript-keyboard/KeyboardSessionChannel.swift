import Foundation
import Network

/// Newline-delimited JSON over a phone-local TCP connection. Limits apply before decoding or allocating
/// an entire frame. Network.framework preserves ordering, including start immediately followed by cancel.
@MainActor
final class KeyboardSessionChannel {
  private let connection: NWConnection
  private let maxBytes: Int
  private var buffer = Data()
  private var closed = false
  var onOpen: () -> Void = {}
  var onMessage: (Data) -> Void = { _ in }
  var onClose: () -> Void = {}

  init(_ connection: NWConnection, maxBytes: Int) {
    self.connection = connection
    self.maxBytes = maxBytes
  }

  deinit { connection.cancel() }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      MainActor.assumeIsolated {
        guard let self, !self.closed else { return }
        switch state {
        case .ready:
          self.onOpen()
          self.receive()
        case .failed, .cancelled: self.close()
        default: break
        }
      }
    }
    // All state, receive, and send callbacks below are delivered on this queue.
    connection.start(queue: .main)
  }

  func send<T: Encodable>(_ value: T, closeAfter: Bool = false) {
    guard !closed, var data = KeyboardSession.encode(value) else { return }
    data.append(0x0a)
    connection.send(content: data, contentContext: closeAfter ? .finalMessage : .defaultMessage,
      isComplete: true, completion: .contentProcessed { [self] error in
      MainActor.assumeIsolated {
        if error != nil || closeAfter { self.close() }
      }
    })
  }

  func close() {
    guard !closed else { return }
    closed = true
    connection.stateUpdateHandler = nil
    connection.cancel()
    buffer.removeAll()
    onClose()
    onOpen = {}
    onMessage = { _ in }
    onClose = {}
  }

  private func receive() {
    guard !closed else { return }
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, complete, error in
      MainActor.assumeIsolated {
        guard let self, !self.closed else { return }
        if let data {
          self.buffer.append(data)
          while let end = self.buffer.firstIndex(of: 0x0a) {
            let size = self.buffer.distance(from: self.buffer.startIndex, to: end)
            guard size > 0, size <= self.maxBytes else { return self.close() }
            let message = Data(self.buffer[..<end])
            self.buffer.removeSubrange(...end)
            self.onMessage(message)
            if self.closed { return }
          }
          guard self.buffer.count <= self.maxBytes else { return self.close() }
        }
        if complete || error != nil { self.close() } else { self.receive() }
      }
    }
  }
}
