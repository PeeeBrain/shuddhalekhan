import Foundation

// Run by scripts/build-ios.sh on macOS: swiftc KeyboardSessionProtocol.swift KeyboardSessionCheck.swift.
@main
struct KeyboardSessionCheck {
  static func main() {
    typealias S = KeyboardSession
    let now: Int64 = 1_800_000_000_000
    let live = S.State(sessionEndsAt: now + 60_000, requestId: nil, mode: nil, agentReady: true,
      phase: .idle, text: nil, error: nil, level: nil)
    func command(_ id: String, _ action: S.Command.Action, mode: S.Mode = .dictate, at: Int64 = now) -> S.Command {
      .init(id: id, action: action, mode: mode, sentAt: at)
    }

    // Commands only drive the request they name, and only inside a live session.
    let recording = S.transition(live, on: command("a", .start), now: now)
    precondition(recording?.phase == .recording && recording?.requestId == "a")
    precondition(S.transition(S.State.ended, on: command("a", .start), now: now) == nil, "no session")
    precondition(S.transition(recording!, on: command("b", .start), now: now) == nil, "busy")
    precondition(S.transition(recording!, on: command("b", .stop), now: now) == nil, "wrong request")
    let transcribing = S.transition(recording!, on: command("a", .stop), now: now)!
    precondition(transcribing.phase == .transcribing)
    precondition(S.transition(transcribing, on: command("a", .stop), now: now) == nil, "duplicate stop")
    precondition(S.transition(transcribing, on: command("a", .cancel), now: now)?.phase == .cancelled)
    let done = transcribing.with(.done, requestId: "a", text: "hello")
    precondition(S.transition(done, on: command("a", .start), now: now) == nil, "replayed start")
    precondition(S.transition(done, on: command("c", .start), now: now)?.requestId == "c")

    // Stale or malformed commands never decode.
    let fresh = S.encode(command("a", .start))!
    precondition(S.decodeCommand(fresh, now: now) != nil)
    precondition(S.decodeCommand(S.encode(command("a", .start, at: now - 16_000))!, now: now) == nil, "stale")
    precondition(S.decodeCommand(S.encode(command(" ", .start))!, now: now) == nil, "blank id")
    precondition(S.decodeCommand(Data("{\"id\":\"a\",\"action\":\"record\",\"mode\":\"dictate\",\"sentAt\":\(now)}".utf8), now: now) == nil)

    // The keyboard inserts only its own finished request, once.
    precondition(S.insertion(done, pendingId: "a", inserted: []) == "hello")
    precondition(S.insertion(done, pendingId: "a", inserted: ["a"]) == nil, "already inserted")
    precondition(S.insertion(done, pendingId: "b", inserted: []) == nil, "other request")
    precondition(S.insertion(transcribing, pendingId: "a", inserted: []) == nil, "not finished")
    precondition(S.decodeState(S.encode(done)!) == done)
    let huge = done.with(.done, requestId: "a", text: String(repeating: "x", count: S.maxTextBytes + 1))
    precondition(S.decodeState(S.encode(huge)!) == nil, "oversized text")

    // Agent commands round-trip without ever becoming host-app insertion text.
    let agentStart = command("agent", .start, mode: .agent)
    precondition(S.decodeCommand(S.encode(agentStart)!, now: now) == agentStart)
    let agentRecording = S.transition(live, on: agentStart, now: now)!
    precondition(agentRecording.mode == .agent)
    precondition(S.transition(agentRecording, on: command("agent", .stop), now: now) == nil, "wrong mode")
    let agentTranscribing = S.transition(agentRecording, on: command("agent", .stop, mode: .agent), now: now)!
    let agentDone = agentTranscribing.with(.done, requestId: "agent", text: "do something")
    precondition(S.decodeState(S.encode(agentDone)!) == agentDone)
    precondition(S.insertion(agentDone, pendingId: "agent", inserted: []) == nil, "never type agent prompts")
    let unconfigured = S.State(sessionEndsAt: live.sessionEndsAt, requestId: nil, mode: nil, agentReady: false,
      phase: .idle, text: nil, error: nil, level: nil)
    let refused = S.transition(unconfigured, on: agentStart, now: now)!
    precondition(refused.phase == .failed && refused.error != nil && refused.mode == .agent, "visible setup failure")
    precondition(S.transition(unconfigured, on: command("dictate", .start), now: now)?.phase == .recording,
      "dictation must work without Agent Mode")

    // Meter frames cannot leak past recording or accept unbounded values at the socket boundary.
    let metered = agentRecording.with(.recording, requestId: "agent", level: 0.7)
    precondition(S.decodeState(S.encode(metered)!) == metered)
    precondition(S.transition(metered, on: command("agent", .stop, mode: .agent), now: now)?.level == nil)
    precondition(S.transition(metered, on: command("agent", .cancel, mode: .agent), now: now)?.level == nil)
    for (phase, level) in [(S.State.Phase.done, Float(0.5)), (.recording, -0.1), (.recording, 1.1)] {
      let invalid = S.State(sessionEndsAt: live.sessionEndsAt, requestId: "agent", mode: .agent, agentReady: true,
        phase: phase, text: nil, error: nil, level: level)
      precondition(S.decodeState(S.encode(invalid)!) == nil, "invalid meter frame")
    }
    print("KeyboardSessionCheck passed")
  }
}
