import ActivityKit

// The app and widget targets compile identical copies; ActivityKit matches them by type name and shape.
// Phases: running, awaitingApproval, completed, failed, cancelled, interrupted.
struct AgentActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var phase: String
    var status: String
    var answerPreview: String?
    var approvalId: String?
  }

  var runId: String
}
