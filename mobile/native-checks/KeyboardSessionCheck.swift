import Foundation

// Run by scripts/build-ios.sh on macOS: swiftc KeyboardSessionProtocol.swift KeyboardSessionCheck.swift.
@main
struct KeyboardSessionCheck {
  static func main() {
    typealias S = KeyboardSession
    let now: Int64 = 1_800_000_000_000
    let live = S.State(sessionEndsAt: now + 60_000, requestId: nil, phase: .idle, text: nil, error: nil)
    func command(_ id: String, _ action: S.Command.Action, at: Int64 = now) -> S.Command { .init(id: id, action: action, sentAt: at) }

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
    precondition(S.decodeCommand(Data("{\"id\":\"a\",\"action\":\"record\",\"sentAt\":\(now)}".utf8), now: now) == nil)

    // The keyboard inserts only its own finished request, once.
    precondition(S.insertion(done, pendingId: "a", inserted: []) == "hello")
    precondition(S.insertion(done, pendingId: "a", inserted: ["a"]) == nil, "already inserted")
    precondition(S.insertion(done, pendingId: "b", inserted: []) == nil, "other request")
    precondition(S.insertion(transcribing, pendingId: "a", inserted: []) == nil, "not finished")
    precondition(S.decodeState(S.encode(done)!) == done)
    let huge = done.with(.done, requestId: "a", text: String(repeating: "x", count: S.maxTextBytes + 1))
    precondition(S.decodeState(S.encode(huge)!) == nil, "oversized text")
    print("KeyboardSessionCheck passed")
  }
}
