import ActivityKit
import Foundation

// ActivityKit matches app and widget attributes by type name and shape.
// Phases: keyboardSession, running, awaitingApproval, completed, failed, cancelled, interrupted.
struct AgentActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var phase: String
    var status: String
    var answerPreview: String?
    var approvalId: String?
    // Session activities keep their attributes as later keyboard runs replace their content.
    var runId: String? = nil
    var sessionEndsAt: Date? = nil
  }

  var runId: String
}
