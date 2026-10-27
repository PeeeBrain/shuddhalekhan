import ActivityKit
import BackgroundTasks
import Foundation
import OSLog
import UIKit

@MainActor
final class AgentActivityManager {
  static let shared = AgentActivityManager()

  var onStopped: ((String) -> Void)?
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "AgentActivity")
  private let store = AgentRunStore(directory: URL.applicationSupportDirectory.appendingPathComponent("AgentActivity"))
  private var record: AgentRunRecord?
  private var activity: Activity<AgentActivityAttributes>?
  private var processingTask: BGTask?
  private var processingIdentifier: String?
  private var progressBaseline = 0
  private var expirationFallback: Task<Void, Never>?

  func start(maximumSteps: Int) async throws -> String {
    guard UIApplication.shared.applicationState == .active else { throw AgentRunError.requiresForeground }
    guard (1...34).contains(maximumSteps) else { throw AgentRunError.invalidUpdate }
    guard record?.phase.isTerminal != false else { throw AgentRunError.alreadyRunning }
    await dismissActivities()
    let next = AgentRunRecord(maximumSteps: maximumSteps)
    try store.save(next)
    record = next
    if ActivityAuthorizationInfo().areActivitiesEnabled {
      do {
        activity = try Activity.request(attributes: AgentActivityAttributes(runId: next.runId), content: content(next), pushType: nil)
      } catch { log.error("AgentActivity stage=start_activity_failed") }
    }
    submitProcessing(for: next)
    log.notice("AgentActivity run=\(next.runId, privacy: .public) stage=started")
    return next.runId
  }

  func resume(runId: String) async throws {
    guard UIApplication.shared.applicationState == .active else { throw AgentRunError.requiresForeground }
    guard var current = record, current.runId == runId else { throw AgentRunError.unknownRun }
    do { try current.resume() }
    catch { await interrupt(runId: runId); throw error }
    try store.save(current)
    record = current
    submitProcessing(for: current)
    await activity?.update(content(current))
  }

  func canContinueInBackground(runId: String) -> Bool {
    record?.runId == runId && record?.phase == .running && processingTask != nil
  }

  func update(_ update: AgentRunUpdate) async throws {
    guard var current = record, current.runId == update.runId else { return }
    // An expiry has already published interruption; JS acknowledges after abort/cleanup.
    if current.phase == .interrupted && update.phase.isTerminal {
      finishProcessing(success: false)
      return
    }
    guard try current.apply(update) else { return }
    var persistenceError: Error?
    do { try store.save(current) } catch { persistenceError = error }
    record = current
    if #available(iOS 26.0, *), let task = processingTask as? BGContinuedProcessingTask {
      // The runner enforces this request ceiling; only completed real requests advance the bar.
      task.progress.completedUnitCount = Int64(max(0, current.completedSteps - progressBaseline))
      // The system progress UI has no privacy-redaction hook for server/tool names.
      if current.phase == .awaitingApproval {
        task.updateTitle("Agent needs approval", subtitle: "Open Shuddhalekhan to review a tool request.")
      } else if current.phase.isTerminal {
        task.updateTitle(current.phase == .completed ? "Agent finished" : "Agent stopped", subtitle: "Open Shuddhalekhan for details.")
      }
    }
    if current.phase.isTerminal {
      if current.phase == .completed && UIApplication.shared.applicationState != .active {
        await activity?.update(content(current), alertConfiguration: AlertConfiguration(
          title: "Agent finished", body: "Open Shuddhalekhan to read the answer.", sound: .default))
      }
      await activity?.end(content(current), dismissalPolicy: .after(Date().addingTimeInterval(5 * 60)))
      activity = nil
    } else {
      let alert: AlertConfiguration? = current.phase == .awaitingApproval && UIApplication.shared.applicationState != .active
        ? AlertConfiguration(title: "Approval needed", body: "Open Shuddhalekhan to review a tool request.", sound: .default)
        : nil
      await activity?.update(content(current), alertConfiguration: alert)
    }
    // Publish the decision/result before giving iOS permission to suspend the process.
    if (current.phase == .awaitingApproval || current.phase.isTerminal), record?.phase == current.phase {
      finishProcessing(success: current.phase == .awaitingApproval || current.phase == .completed)
    }
    log.notice("AgentActivity run=\(current.runId, privacy: .public) phase=\(current.phase.rawValue, privacy: .public) steps=\(current.completedSteps, privacy: .public)")
    if let persistenceError { throw persistenceError }
  }

  func recover() async throws -> AgentRunRecord? {
    if record != nil {
      await checkApprovalExpiry()
      return record
    }
    guard var saved = try store.load() else {
      await dismissActivities()
      return nil
    }
    if !saved.phase.isTerminal {
      saved.interrupt()
      try store.save(saved)
    }
    record = saved
    for old in Activity<AgentActivityAttributes>.activities {
      await old.end(old.attributes.runId == saved.runId ? content(saved) : nil, dismissalPolicy: .immediate)
    }
    return saved
  }

  func clear(runId: String) async throws {
    guard record?.runId == runId else { return }
    guard record?.phase.isTerminal == true else { throw AgentRunError.alreadyRunning }
    try store.clear()
    record = nil
    await dismissActivities()
  }

  func enterBackground() async {
    guard let current = record, current.phase == .running, !canContinueInBackground(runId: current.runId) else { return }
    await interrupt(runId: current.runId)
  }

  func checkApprovalExpiry() async {
    guard let current = record, current.phase == .awaitingApproval,
      let expiry = current.approvalExpiresAt, expiry <= Date() else { return }
    await interrupt(runId: current.runId)
  }

  func stopCurrentRun() async {
    guard let current = record, !current.phase.isTerminal else { return }
    await interrupt(runId: current.runId)
    finishProcessing(success: false)
  }

  func stopRun(runId: String) async {
    guard record?.runId == runId else { return }
    await interrupt(runId: runId)
    finishProcessing(success: false)
  }

  private func submitProcessing(for current: AgentRunRecord) {
    guard #available(iOS 26.0, *), UIApplication.shared.applicationState == .active else { return }
    finishProcessing(success: true)
    // Dynamic continued-processing registrations are made at the foreground user action, once per identifier.
    guard let patterns = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String],
      let pattern = patterns.first(where: { $0.hasSuffix(".agent.*") }) else { return }
    let identifier = String(pattern.dropLast()) + UUID().uuidString
    let runId = current.runId
    let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { [weak self] task in
      // The scheduler was explicitly given the main queue.
      MainActor.assumeIsolated {
        guard let self else { task.setTaskCompleted(success: false); return }
        self.install(task, identifier: identifier, runId: runId)
      }
    }
    guard registered else { log.error("AgentActivity stage=background_registration_failed"); return }
    processingIdentifier = identifier
    let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: "Shuddhalekhan agent", subtitle: "Working on your command.")
    request.strategy = .fail
    do { try BGTaskScheduler.shared.submit(request) }
    catch {
      processingIdentifier = nil
      log.notice("AgentActivity run=\(runId, privacy: .public) stage=background_unavailable")
    }
  }

  @available(iOS 26.0, *)
  private func install(_ rawTask: BGTask, identifier: String, runId: String) {
    guard let task = rawTask as? BGContinuedProcessingTask, processingIdentifier == identifier,
      let current = record, current.runId == runId, current.phase == .running else {
      rawTask.setTaskCompleted(success: false)
      return
    }
    processingTask = task
    progressBaseline = current.completedSteps
    task.progress.totalUnitCount = Int64(max(1, current.maximumSteps - progressBaseline))
    task.expirationHandler = { [weak self] in
      Task { @MainActor in
        guard let self, self.processingIdentifier == identifier else { return }
        await self.interrupt(runId: runId)
      }
    }
    log.notice("AgentActivity run=\(runId, privacy: .public) stage=background_granted")
  }

  private func finishProcessing(success: Bool) {
    expirationFallback?.cancel()
    expirationFallback = nil
    let task = processingTask
    let identifier = processingIdentifier
    processingTask = nil
    processingIdentifier = nil
    if let task {
      task.expirationHandler = nil
      if #available(iOS 26.0, *), let continued = task as? BGContinuedProcessingTask, success {
        continued.progress.completedUnitCount = continued.progress.totalUnitCount
      }
      task.setTaskCompleted(success: success)
    } else if let identifier {
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
    }
  }

  private func interrupt(runId: String) async {
    guard var current = record, current.runId == runId, !current.phase.isTerminal else { return }
    current.interrupt()
    record = current
    do { try store.save(current) }
    catch { log.error("AgentActivity stage=interruption_persistence_failed") }
    onStopped?(runId)
    if processingTask != nil {
      // Let JS abort its requests and acknowledge cleanup; the deadline also covers a lost JS runtime.
      let identifier = processingIdentifier
      expirationFallback = Task { @MainActor [weak self] in
        do { try await Task.sleep(for: .seconds(3)) } catch { return }
        guard let self, self.processingIdentifier == identifier else { return }
        self.finishProcessing(success: false)
      }
    } else {
      finishProcessing(success: false)
    }
    await activity?.end(content(current), dismissalPolicy: .after(Date().addingTimeInterval(5 * 60)))
    activity = nil
    log.notice("AgentActivity run=\(runId, privacy: .public) stage=interrupted")
  }

  private func content(_ record: AgentRunRecord) -> ActivityContent<AgentActivityAttributes.ContentState> {
    ActivityContent(state: AgentActivityAttributes.ContentState(phase: record.phase.rawValue, status: record.status,
      answerPreview: record.answerPreview, approvalId: record.approvalId),
      staleDate: record.phase.isTerminal ? nil : record.approvalExpiresAt ?? Date().addingTimeInterval(120))
  }

  private func dismissActivities() async {
    activity = nil
    for old in Activity<AgentActivityAttributes>.activities { await old.end(nil, dismissalPolicy: .immediate) }
  }
}
