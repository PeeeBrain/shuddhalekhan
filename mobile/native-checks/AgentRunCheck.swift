import Foundation

// Compiles the real record/store, without ActivityKit or Expo, before the Release archive.
@main
struct AgentRunCheck {
  static func main() throws {
    let now = Date(timeIntervalSince1970: 1_000)
    var run = AgentRunRecord(maximumSteps: 24)
    let id = run.runId
    let wrong = AgentRunUpdate(runId: "stale-run", phase: .completed, status: "Done", completedSteps: 1, response: "Wrong")
    let acceptedWrong = try run.apply(wrong, now: now)
    precondition(!acceptedWrong)
    let approval = AgentRunUpdate(runId: id, phase: .awaitingApproval, status: "Review", completedSteps: 1, approvalId: "approval-1")
    let acceptedApproval = try run.apply(approval, now: now)
    precondition(acceptedApproval)
    let expiry = run.approvalExpiresAt
    _ = try run.apply(approval, now: now.addingTimeInterval(100))
    precondition(run.approvalExpiresAt == expiry, "Publishing an approval must not extend its deadline")
    let lateStatus = AgentRunUpdate(runId: id, phase: .running, status: "Old status", completedSteps: 1)
    let acceptedLateStatus = try run.apply(lateStatus, now: now)
    precondition(!acceptedLateStatus)
    precondition(run.phase == .awaitingApproval && run.approvalId == "approval-1")
    var expired = run
    do { try expired.resume(now: now.addingTimeInterval(901)); preconditionFailure("Expired approval resumed") }
    catch AgentRunError.expiredApproval { }
    try run.resume(now: now.addingTimeInterval(1))
    precondition(run.approvalId == nil && run.phase == .running)
    let answer = String(repeating: "😀", count: 500)
    let acceptedAnswer = try run.apply(AgentRunUpdate(runId: id, phase: .completed, status: "Answer ready", completedSteps: 2, response: answer))
    precondition(acceptedAnswer)
    precondition(run.answerPreview?.utf8.count == 640)
    let revived = try run.apply(lateStatus)
    precondition(!revived)
    precondition(run.phase == .completed && run.response == answer)
    let combining = "a" + String(repeating: "\u{0301}", count: 10_000)
    precondition(AgentRunRecord.bounded(combining, limit: 160).utf8.count <= 640)

    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = AgentRunStore(directory: directory)
    try store.save(run)
    let restored = try store.load()
    precondition(restored?.runId == id && restored?.response == answer && restored?.phase == .completed)
    var interrupted = AgentRunRecord(maximumSteps: 24)
    interrupted.interrupt()
    precondition(interrupted.phase == .interrupted && interrupted.approvalId == nil)
    try store.clear()
    let cleared = try store.load()
    precondition(cleared == nil)
    print("Agent run state, expiry, payload bounds and storage checks passed.")
  }
}
