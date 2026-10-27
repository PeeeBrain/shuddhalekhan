import Foundation

enum AgentRunPhase: String, Codable, Sendable {
  case running, awaitingApproval, completed, failed, cancelled, interrupted

  var isTerminal: Bool { self != .running && self != .awaitingApproval }
}

struct AgentRunUpdate: Sendable {
  var runId: String
  var phase: AgentRunPhase
  var status: String
  var completedSteps: Int
  var approvalId: String?
  var response: String?
}

struct AgentRunRecord: Codable, Sendable {
  var runId = UUID().uuidString
  var phase = AgentRunPhase.running
  var status = "Starting agent…"
  var completedSteps = 0
  var maximumSteps: Int
  var approvalId: String?
  var approvalExpiresAt: Date?
  var response = ""

  var answerPreview: String? {
    guard phase == .completed, !response.isEmpty else { return nil }
    return Self.bounded(response, limit: 160)
  }

  mutating func apply(_ update: AgentRunUpdate, now: Date = Date()) throws -> Bool {
    guard update.runId == runId, !phase.isTerminal else { return false }
    // Only the explicit foreground resume method can leave an approval wait.
    if phase == .awaitingApproval && update.phase == .running { return false }
    guard update.completedSteps >= completedSteps, update.completedSteps <= maximumSteps,
      (update.response?.utf8.count ?? 0) <= 800_000 else { throw AgentRunError.invalidUpdate }
    if update.phase == .awaitingApproval {
      guard let id = update.approvalId, !id.isEmpty, id.count <= 100 else { throw AgentRunError.invalidUpdate }
      approvalId = id
      approvalExpiresAt = now.addingTimeInterval(15 * 60)
    } else {
      approvalId = nil
      approvalExpiresAt = nil
    }
    phase = update.phase
    status = Self.bounded(update.status, limit: 160)
    completedSteps = update.completedSteps
    response = phase == .completed ? update.response ?? "" : ""
    return true
  }

  mutating func resume(now: Date = Date()) throws {
    guard phase == .awaitingApproval, let expiry = approvalExpiresAt, expiry > now else { throw AgentRunError.expiredApproval }
    phase = .running
    approvalId = nil
    approvalExpiresAt = nil
    status = "Resuming agent…"
  }

  mutating func interrupt() {
    guard !phase.isTerminal else { return }
    phase = .interrupted
    status = "Run interrupted. Tools already started may still finish."
    approvalId = nil
    approvalExpiresAt = nil
    response = ""
  }

  static func bounded(_ value: String, limit: Int) -> String {
    let plain = value.components(separatedBy: .controlCharacters).joined(separator: " ")
    var result = ""
    var bytes = 0
    // A single grapheme can contain thousands of combining scalars; character limits alone don't fit ActivityKit.
    for character in plain.prefix(limit) {
      let size = String(character).utf8.count
      if bytes + size > limit * 4 { break }
      result.append(character)
      bytes += size
    }
    return result
  }
}

enum AgentRunError: Error {
  case invalidUpdate, alreadyRunning, unknownRun, expiredApproval, requiresForeground
}

/** One result, no conversation history. Protection permits updates while an already-unlocked phone is locked. */
struct AgentRunStore {
  let directory: URL
  private var file: URL { directory.appendingPathComponent("last-run.json") }

  func load() throws -> AgentRunRecord? {
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    let data = try Data(contentsOf: file)
    guard data.count <= 2_000_000 else { throw AgentRunError.invalidUpdate }
    let record = try JSONDecoder().decode(AgentRunRecord.self, from: data)
    guard !record.runId.isEmpty, record.runId.count <= 100, (1...34).contains(record.maximumSteps),
      (0...record.maximumSteps).contains(record.completedSteps), record.response.utf8.count <= 800_000 else { throw AgentRunError.invalidUpdate }
    return record
  }

  func save(_ record: AgentRunRecord) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var excluded = directory
    var resources = URLResourceValues()
    resources.isExcludedFromBackup = true
    try excluded.setResourceValues(resources)
    let data = try JSONEncoder().encode(record)
    #if os(iOS)
    try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
    try data.write(to: file, options: .atomic)
    #endif
  }

  func clear() throws {
    if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
  }
}
