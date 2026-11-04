import Foundation

// Both targets compile identical copies (build-ios.sh checks). The foreground app publishes only a
// loopback port and session secret to a team-scoped named pasteboard. All commands and results use TCP:
// iOS denies the containing app pasteboard access while it records in the background.
enum KeyboardSession {
  enum Mode: String, Codable, Sendable { case dictate, agent }
  static let discoveryPasteboard = "com.shuddhalekhan.mobile.session.connection.v2"
  static let payloadType = "com.shuddhalekhan.mobile.session.v2"
  static let maxTextBytes = 200_000
  static let maxErrorBytes = 500
  static let maxCommandAgeMs: Int64 = 15_000
  static let maxClockSkewMs: Int64 = 5_000

  struct Bridge: Codable, Equatable, Sendable {
    let port: UInt16
    let token: String
    let expiresAt: Int64
  }

  struct Request: Codable, Sendable {
    let token: String
    let command: Command?
  }

  static func decodeBridge(_ data: Data, now: Int64) -> Bridge? {
    guard data.count <= 1_000, let bridge = try? JSONDecoder().decode(Bridge.self, from: data),
          bridge.port > 0, bridge.token.utf8.count == 44, bridge.expiresAt > now else { return nil }
    return bridge
  }

  static func decodeRequest(_ data: Data, token: String, now: Int64) -> Request? {
    guard data.count <= 2_000, let request = try? JSONDecoder().decode(Request.self, from: data),
          request.token == token else { return nil }
    if let command = request.command {
      guard let encoded = encode(command), decodeCommand(encoded, now: now) != nil else { return nil }
    }
    return request
  }

  struct Command: Codable, Equatable, Sendable {
    enum Action: String, Codable, Sendable { case start, stop, cancel }
    let id: String
    let action: Action
    let mode: Mode
    let sentAt: Int64
  }

  struct State: Codable, Equatable, Sendable {
    enum Phase: String, Codable, Sendable { case idle, recording, transcribing, done, failed, cancelled }
    /// Milliseconds since 1970; 0 means no session.
    let sessionEndsAt: Int64
    let requestId: String?
    let mode: Mode?
    let agentReady: Bool
    let phase: Phase
    let text: String?
    let error: String?
    let level: Float?

    static let ended = State(sessionEndsAt: 0, requestId: nil, mode: nil, agentReady: false,
      phase: .idle, text: nil, error: nil, level: nil)

    func isLive(now: Int64) -> Bool { sessionEndsAt > now }
    var isBusy: Bool { phase == .recording || phase == .transcribing }
    func with(_ phase: Phase, requestId: String?, mode: Mode? = nil, text: String? = nil,
              error: String? = nil, level: Float? = nil) -> State {
      State(sessionEndsAt: sessionEndsAt, requestId: requestId, mode: requestId == nil ? nil : mode ?? self.mode,
        agentReady: agentReady, phase: phase, text: text, error: error, level: phase == .recording ? level : nil)
    }
  }

  static func encode<T: Encodable>(_ value: T) -> Data? { try? JSONEncoder().encode(value) }

  static func decodeCommand(_ data: Data, now: Int64) -> Command? {
    guard data.count <= 1_000,
          let command = try? JSONDecoder().decode(Command.self, from: data),
          validId(command.id),
          command.sentAt >= now - maxCommandAgeMs,
          command.sentAt <= now + maxClockSkewMs else { return nil }
    return command
  }

  static func decodeState(_ data: Data) -> State? {
    guard data.count <= maxTextBytes * 7,
          let state = try? JSONDecoder().decode(State.self, from: data),
          state.requestId.map(validId) ?? true,
          (state.requestId == nil) == (state.mode == nil),
          (state.phase == .idle || state.requestId != nil),
          state.level.map({ state.phase == .recording && $0.isFinite && (0...1).contains($0) }) ?? true,
          (state.text?.utf8.count ?? 0) <= maxTextBytes,
          (state.error?.utf8.count ?? 0) <= maxErrorBytes else { return nil }
    return state
  }

  /// App side: the state a command leads to, or nil when it must be ignored (session over, wrong or stale request).
  static func transition(_ state: State, on command: Command, now: Int64) -> State? {
    switch command.action {
    case .start:
      guard state.isLive(now: now), !state.isBusy, command.id != state.requestId else { return nil }
      if command.mode == .agent && !state.agentReady {
        return state.with(.failed, requestId: command.id, mode: command.mode,
          error: "Set up Agent Mode in Shuddhalekhan first.")
      }
      return state.with(.recording, requestId: command.id, mode: command.mode)
    case .stop:
      guard command.id == state.requestId, command.mode == state.mode, state.phase == .recording else { return nil }
      return state.with(.transcribing, requestId: command.id)
    case .cancel:
      guard command.id == state.requestId, command.mode == state.mode, state.isBusy else { return nil }
      return state.with(.cancelled, requestId: command.id)
    }
  }

  /// Keyboard side: text to insert for the request this keyboard started, at most once per request.
  static func insertion(_ state: State, pendingId: String?, inserted: Set<String>) -> String? {
    guard state.mode == .dictate, let pendingId, state.requestId == pendingId, state.phase == .done, !inserted.contains(pendingId),
          let text = state.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return text
  }

  static func nowMs(_ date: Date = Date()) -> Int64 { Int64(date.timeIntervalSince1970 * 1_000) }

  private static func validId(_ id: String) -> Bool {
    !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && id.utf8.count <= 128
  }
}
