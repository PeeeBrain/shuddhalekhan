import ExpoModulesCore

private struct ActivityUpdateInput: Record {
  @Field var runId: String = ""
  @Field var phase: String = ""
  @Field var status: String = ""
  @Field var completedSteps: Int = 0
  @Field var approvalId: String?
  @Field var response: String?

  func checked() throws -> AgentRunUpdate {
    guard let phase = AgentRunPhase(rawValue: phase), !runId.isEmpty, runId.count <= 100,
      status.utf8.count <= 4_000, (response?.utf8.count ?? 0) <= 800_000 else { throw AgentRunError.invalidUpdate }
    return AgentRunUpdate(runId: runId, phase: phase, status: status, completedSteps: completedSteps, approvalId: approvalId, response: response)
  }
}

// Expo calls across queues; this module holds no mutable state. Its manager is isolated to MainActor.
public final class ShuddhalekhanAgentActivityModule: Module, @unchecked Sendable {
  public func definition() -> ModuleDefinition {
    Name("ShuddhalekhanAgentActivity")
    Events("onAgentRunStopped")

    OnCreate {
      Task { @MainActor [weak self] in
        AgentActivityManager.shared.onStopped = { [weak self] runId in
          self?.sendEvent("onAgentRunStopped", ["runId": runId])
        }
      }
    }
    OnAppEntersBackground {
      Task { @MainActor in await AgentActivityManager.shared.enterBackground() }
    }
    OnAppBecomesActive {
      Task { @MainActor in await AgentActivityManager.shared.checkApprovalExpiry() }
    }
    OnAppContextDestroys {
      Task { @MainActor in await AgentActivityManager.shared.stopCurrentRun() }
    }

    AsyncFunction("start") { (maximumSteps: Int) async throws -> [String: String] in
      let runId = try await AgentActivityManager.shared.start(maximumSteps: maximumSteps)
      return ["runId": runId]
    }
    AsyncFunction("resume") { (runId: String) async throws in
      try await AgentActivityManager.shared.resume(runId: runId)
    }
    AsyncFunction("canContinueInBackground") { (runId: String) async -> Bool in
      await AgentActivityManager.shared.canContinueInBackground(runId: runId)
    }
    AsyncFunction("prepareApproval") { (input: ActivityUpdateInput) async throws in
      let update = try input.checked()
      try await AgentActivityManager.shared.prepareApproval(update)
    }
    AsyncFunction("update") { (input: ActivityUpdateInput) async throws in
      do {
        let update = try input.checked()
        try await AgentActivityManager.shared.update(update)
      } catch {
        await AgentActivityManager.shared.stopRun(runId: input.runId)
        throw error
      }
    }
    AsyncFunction("recover") { () async throws -> [String: String]? in
      guard let record = try await AgentActivityManager.shared.recover() else { return nil }
      return ["runId": record.runId, "phase": record.phase.rawValue, "response": record.response]
    }
    AsyncFunction("clear") { (runId: String) async throws in
      try await AgentActivityManager.shared.clear(runId: runId)
    }
  }
}
