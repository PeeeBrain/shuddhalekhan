import ActivityKit
import BackgroundTasks
import Foundation
import OSLog
import UIKit

@MainActor
final class AgentActivityManager {
  static let shared = AgentActivityManager()

  var onStopped: ((String) -> Void)?
  var onApprovalAction: (() -> Void)?
  private let log = Logger(subsystem: "com.shuddhalekhan.mobile", category: "AgentActivity")
  private let store = AgentRunStore(directory: URL.applicationSupportDirectory.appendingPathComponent("AgentActivity"))
  private var record: AgentRunRecord?
  private var activityId: String?
  private var processingTask: BGTask?
  private var processingIdentifier: String?
  private var progressBaseline = 0
  private var expirationFallback: Task<Void, Never>?
  private var pendingApprovalAction: AgentApprovalAction?
  private var notifiedApprovalId: String?
  private var keyboardSessionActive = false
  private var keyboardSessionActivityId: String?
  private var keyboardSessionEndsAt: Date?
  private var keyboardSessionObserver: NSObjectProtocol?
  private var usesSystemActivity: Bool {
    if #available(iOS 26.0, *) { return true }
    return false
  }

  private init() {
    keyboardSessionObserver = NotificationCenter.default.addObserver(
      forName: Notification.Name("ShuddhalekhanKeyboardSessionActive"), object: nil, queue: .main
    ) { [weak self] notification in
      // Read the non-Sendable notification here; only Sendable values cross into the main-actor closure.
      let active = notification.userInfo?["active"] as? Bool
      let agentReady = notification.userInfo?["agentReady"] as? Bool == true
      let endsAt = notification.userInfo?["endsAt"] as? Date
      MainActor.assumeIsolated {
        guard let self, let active else { return }
        self.keyboardSessionActive = active
        if active {
          if let endsAt { self.startKeyboardSessionActivity(endsAt: endsAt) }
          if agentReady { AgentNotifications.shared.requestAuthorization() }
        } else {
          self.keyboardSessionEndsAt = nil
          // Audio no longer keeps JS alive. Finish activity cleanup and interruption before suspension.
          let backgrounded = UIApplication.shared.applicationState != .active
          let deadline = backgrounded ? UIApplication.shared.beginBackgroundTask(withName: "Keyboard agent interruption") : .invalid
          let idleActivityId = self.keyboardSessionActivityId != self.activityId || self.record?.phase.isTerminal != false
            ? self.keyboardSessionActivityId : nil
          if let idleActivityId {
            self.keyboardSessionActivityId = nil
            if self.activityId == idleActivityId { self.activityId = nil }
          }
          Task { @MainActor in
            await Self.activity(id: idleActivityId)?.end(nil, dismissalPolicy: .immediate)
            if backgrounded, UIApplication.shared.applicationState != .active { await self.enterBackground() }
            if deadline != .invalid { UIApplication.shared.endBackgroundTask(deadline) }
          }
        }
      }
    }
  }

  func start(maximumSteps: Int) async throws -> String {
    guard UIApplication.shared.applicationState == .active || keyboardSessionActive else { throw AgentRunError.requiresForeground }
    guard (1...34).contains(maximumSteps) else { throw AgentRunError.invalidUpdate }
    guard record?.phase.isTerminal != false else { throw AgentRunError.alreadyRunning }
    await dismissActivities()
    guard UIApplication.shared.applicationState == .active || keyboardSessionActive else { throw AgentRunError.requiresForeground }
    guard record?.phase.isTerminal != false else { throw AgentRunError.alreadyRunning }
    if let record { AgentNotifications.shared.removeAll(runId: record.runId) }
    pendingApprovalAction = nil
    notifiedApprovalId = nil
    let next = AgentRunRecord(maximumSteps: maximumSteps)
    try store.save(next)
    record = next
    // Continued processing supplies its own Live Activity on iOS 26; starting ours would duplicate it.
    if keyboardSessionActive, UIApplication.shared.applicationState != .active, let id = keyboardSessionActivityId {
      if Self.isLive(id) {
        activityId = id
        await Self.activity(id: id)?.update(content(next))
        // Session loss can interrupt the run while ActivityKit is updating; don't acknowledge a stopped run.
        guard record?.runId == next.runId, record?.phase == .running else { throw AgentRunError.unknownRun }
      } else {
        keyboardSessionActivityId = nil
        keyboardSessionEndsAt = nil
      }
    } else if UIApplication.shared.applicationState == .active && !usesSystemActivity && ActivityAuthorizationInfo().areActivitiesEnabled {
      do {
        activityId = try Activity.request(attributes: AgentActivityAttributes(runId: next.runId), content: content(next), pushType: nil).id
      } catch { log.error("AgentActivity stage=start_activity_failed") }
    }
    submitProcessing(for: next)
    // Submit while active before the permission alert can temporarily make the app inactive.
    AgentNotifications.shared.requestAuthorization()
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
    pendingApprovalAction = nil
    notifiedApprovalId = nil
    AgentNotifications.shared.removeApproval(runId: runId)
    submitProcessing(for: current)
    await Self.activity(id: activityId)?.update(content(current))
  }

  func canContinueInBackground(runId: String) -> Bool {
    // Waiting for a foreground decision needs no running task; the app may safely suspend.
    record?.runId == runId && (record?.phase == .awaitingApproval ||
      (record?.phase == .running && (processingTask != nil || keyboardSessionActive)))
  }

  func prepareApproval(_ update: AgentRunUpdate, title: String) async throws -> Bool {
    guard update.phase == .awaitingApproval, var current = record, current.runId == update.runId,
      try current.apply(update) else { throw AgentRunError.invalidUpdate }
    try store.save(current)
    record = current
    let notified = await AgentNotifications.shared.approval(run: current, title: title)
    guard let approvalId = current.approvalId, record?.matchesApproval(runId: current.runId, approvalId: approvalId) == true else {
      AgentNotifications.shared.removeApproval(runId: current.runId)
      return false
    }
    notifiedApprovalId = notified ? approvalId : nil
    return notified
  }

  func receiveApprovalAction(_ action: AgentApprovalAction) {
    // Only the OS notification delegate can enqueue a decision. Deep links remain navigation-only.
    guard record?.matchesApproval(runId: action.runId, approvalId: action.approvalId) == true,
      pendingApprovalAction == nil else { return }
    pendingApprovalAction = action
    onApprovalAction?()
  }

  func takeApprovalAction() -> AgentApprovalAction? {
    guard UIApplication.shared.applicationState == .active else { return nil }
    defer { pendingApprovalAction = nil }
    guard let action = pendingApprovalAction,
      record?.matchesApproval(runId: action.runId, approvalId: action.approvalId) == true else { return nil }
    return action
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
        let instruction = notifiedApprovalId == current.approvalId
          ? "Expand the approval notification to approve or deny." : "Open Shuddhalekhan to review a tool request."
        task.updateTitle("Agent needs approval", subtitle: instruction)
      } else if current.phase.isTerminal {
        // The system owns layout and truncation; give it the answer instead of a generic completion message.
        task.updateTitle(current.phase == .completed ? "Agent finished" : "Agent stopped", subtitle: current.answerPreview ?? current.status)
      } else {
        let stage = current.status.hasPrefix("Connecting to ") ? "Connecting to tools…"
          : current.status.hasPrefix("Running ") ? "Running an approved tool…" : "Waiting for the agent…"
        task.updateTitle("Agent working", subtitle: stage)
      }
    }
    if current.phase.isTerminal {
      pendingApprovalAction = nil
      notifiedApprovalId = nil
      AgentNotifications.shared.removeApproval(runId: current.runId)
      if let id = activityId, id == keyboardSessionActivityId, !Self.isLive(id) {
        keyboardSessionActivityId = nil
        keyboardSessionEndsAt = nil
        activityId = nil
      }
      let keyboardRunFailed = activityId != nil && activityId == keyboardSessionActivityId &&
        (current.phase == .failed || current.phase == .interrupted)
      if (activityId == nil || (usesSystemActivity && activityId != keyboardSessionActivityId) || keyboardRunFailed) && UIApplication.shared.applicationState != .active {
        await AgentNotifications.shared.result(run: current)
      }
      let alert: AlertConfiguration? = current.phase == .completed && UIApplication.shared.applicationState != .active
        ? AlertConfiguration(title: "Agent finished", body: "Open Shuddhalekhan to read the answer.", sound: .default) : nil
      await finishActivity(current, alert: alert)
    } else {
      let alert: AlertConfiguration? = current.phase == .awaitingApproval && notifiedApprovalId != current.approvalId && UIApplication.shared.applicationState != .active
        ? AlertConfiguration(title: "Approval needed", body: "Open Shuddhalekhan to review a tool request.", sound: .default)
        : nil
      await Self.activity(id: activityId)?.update(content(current), alertConfiguration: alert)
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
    AgentNotifications.shared.removeAll(runId: saved.runId)
    for old in Activity<AgentActivityAttributes>.activities {
      guard old.id != keyboardSessionActivityId else { continue }
      await old.end(old.attributes.runId == saved.runId ? content(saved) : nil, dismissalPolicy: .immediate)
    }
    return saved
  }

  func clear(runId: String) async throws {
    guard record?.runId == runId else { return }
    guard record?.phase.isTerminal == true else { throw AgentRunError.alreadyRunning }
    try store.clear()
    AgentNotifications.shared.removeAll(runId: runId)
    pendingApprovalAction = nil
    notifiedApprovalId = nil
    record = nil
    await dismissActivities()
    if record == nil, keyboardSessionActive, let id = keyboardSessionActivityId, let endsAt = keyboardSessionEndsAt {
      await Self.activity(id: id)?.update(keyboardSessionContent(endsAt: endsAt))
    }
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
    // An active keyboard session keeps adopted runs alive, including when an approval opens the app.
    guard !keyboardSessionActive || activityId == nil || activityId != keyboardSessionActivityId else { return }
    guard #available(iOS 26.0, *), UIApplication.shared.applicationState == .active else { return }
    finishProcessing(success: true)
    // Dynamic continued-processing registrations are made at the foreground user action, once per identifier.
    guard let patterns = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String],
      let pattern = patterns.first(where: { $0.hasSuffix(".agent.*") }) else { return }
    guard let bundleId = Bundle.main.bundleIdentifier, pattern.hasPrefix(bundleId + ".") else {
      log.error("AgentActivity stage=task_identifier_mismatch")
      return
    }
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
    pendingApprovalAction = nil
    notifiedApprovalId = nil
    AgentNotifications.shared.removeApproval(runId: runId)
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
    await finishActivity(current)
    if UIApplication.shared.applicationState != .active { await AgentNotifications.shared.result(run: current) }
    log.notice("AgentActivity run=\(runId, privacy: .public) stage=interrupted")
  }

  private func content(_ record: AgentRunRecord) -> ActivityContent<AgentActivityAttributes.ContentState> {
    ActivityContent(state: AgentActivityAttributes.ContentState(phase: record.phase.rawValue, status: record.status,
      answerPreview: record.answerPreview, approvalId: record.approvalId, runId: record.runId),
      staleDate: record.phase.isTerminal ? nil : record.approvalExpiresAt ?? Date().addingTimeInterval(120))
  }

  private func dismissActivities() async {
    activityId = nil
    // Preserve only this process's session activity. Recovery still dismisses every stale process's activity.
    for old in Activity<AgentActivityAttributes>.activities where old.id != keyboardSessionActivityId {
      await old.end(nil, dismissalPolicy: .immediate)
    }
  }

  private func keyboardSessionContent(endsAt: Date) -> ActivityContent<AgentActivityAttributes.ContentState> {
    let state = AgentActivityAttributes.ContentState(phase: "keyboardSession", status: "Ready when you switch back to the keyboard.",
      sessionEndsAt: endsAt)
    return ActivityContent(state: state, staleDate: endsAt)
  }

  private func startKeyboardSessionActivity(endsAt: Date) {
    guard keyboardSessionActivityId == nil, endsAt > Date(), UIApplication.shared.applicationState == .active,
      ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    do {
      keyboardSessionActivityId = try Activity.request(attributes: AgentActivityAttributes(runId: UUID().uuidString),
        content: keyboardSessionContent(endsAt: endsAt), pushType: nil).id
      keyboardSessionEndsAt = endsAt
    } catch { log.error("AgentActivity stage=keyboard_session_activity_failed") }
  }

  private func finishActivity(_ current: AgentRunRecord, alert: AlertConfiguration? = nil) async {
    guard record?.runId == current.runId else { return }
    let id = activityId
    let keepForSession = id != nil && id == keyboardSessionActivityId && keyboardSessionActive
    activityId = nil
    if !keepForSession, id == keyboardSessionActivityId {
      keyboardSessionActivityId = nil
      keyboardSessionEndsAt = nil
    }
    if keepForSession || alert != nil {
      await Self.activity(id: id)?.update(content(current), alertConfiguration: alert)
    }
    if !keepForSession {
      await Self.activity(id: id)?.end(content(current), dismissalPolicy: .after(Date().addingTimeInterval(5 * 60)))
    }
  }

  private nonisolated static func isLive(_ id: String) -> Bool {
    guard let state = activity(id: id)?.activityState else { return false }
    return state != .ended && state != .dismissed
  }

  // Keep only a Sendable ID on the actor; each async SDK call receives its own disconnected handle.
  private nonisolated static func activity(id: String?) -> sending Activity<AgentActivityAttributes>? {
    Activity<AgentActivityAttributes>.activities.first { $0.id == id }
  }
}
