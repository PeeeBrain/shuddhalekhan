import ExpoModulesCore
import UIKit
import UserNotifications

public final class AgentActivityAppDelegate: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    AgentNotifications.shared.configure()
    return true
  }
}

@MainActor
final class AgentNotifications: NSObject, UNUserNotificationCenterDelegate {
  static let shared = AgentNotifications()
  private let center = UNUserNotificationCenter.current()
  private var authorizationRequest: Task<Void, Never>?

  func configure() {
    center.delegate = self
    let actions = [
      UNNotificationAction(identifier: "approve", title: "Approve once", options: [.foreground, .authenticationRequired]),
      UNNotificationAction(identifier: "deny", title: "Deny", options: [.foreground, .authenticationRequired, .destructive]),
      UNNotificationAction(identifier: "review", title: "Review arguments", options: [.foreground, .authenticationRequired]),
    ]
    center.setNotificationCategories([UNNotificationCategory(identifier: "agent-approval", actions: actions, intentIdentifiers: [],
      hiddenPreviewsBodyPlaceholder: "A tool request is waiting for your decision.", options: [])])
  }

  func requestAuthorization() {
    guard authorizationRequest == nil else { return }
    authorizationRequest = Task { @MainActor in
      defer { authorizationRequest = nil }
      let settings = await center.notificationSettings()
      if settings.authorizationStatus == .notDetermined && UIApplication.shared.applicationState != .background {
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
      }
    }
  }

  func approval(run: AgentRunRecord, title: String) async -> Bool {
    await authorizationRequest?.value
    let settings = await center.notificationSettings()
    guard settings.authorizationStatus == .authorized, settings.alertSetting == .enabled,
      let approvalId = run.approvalId, let expiry = run.approvalExpiresAt, expiry > Date() else { return false }
    let content = UNMutableNotificationContent()
    content.title = "Agent needs approval"
    content.subtitle = AgentRunRecord.bounded(title, limit: 160)
    content.body = "Approve this tool once, deny it, or review its arguments in Shuddhalekhan."
    content.categoryIdentifier = "agent-approval"
    content.sound = .default
    content.userInfo = ["runId": run.runId, "approvalId": approvalId, "expiresAt": expiry.timeIntervalSince1970]
    return await add(content, identifier: "agent-approval-" + run.runId)
  }

  func result(run: AgentRunRecord) async {
    await authorizationRequest?.value
    let content = UNMutableNotificationContent()
    content.title = run.phase == .completed ? "Agent finished" : "Agent stopped"
    content.body = run.answerPreview ?? "Open Shuddhalekhan for details."
    content.sound = .default
    _ = await add(content, identifier: "agent-result-" + run.runId)
  }

  func removeApproval(runId: String) { remove(["agent-approval-" + runId]) }
  func removeAll(runId: String) { remove(["agent-approval-" + runId, "agent-result-" + runId]) }

  private func remove(_ identifiers: [String]) {
    center.removePendingNotificationRequests(withIdentifiers: identifiers)
    center.removeDeliveredNotifications(withIdentifiers: identifiers)
  }

  private func add(_ content: UNMutableNotificationContent, identifier: String) async -> Bool {
    do {
      try await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
      return true
    } catch { return false }
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    [.banner, .list, .sound]
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    guard response.notification.request.content.categoryIdentifier == "agent-approval" else { return }
    let info = response.notification.request.content.userInfo
    guard let runId = info["runId"] as? String, let approvalId = info["approvalId"] as? String,
      let expiry = info["expiresAt"] as? Double, expiry > Date().timeIntervalSince1970,
      let kind = AgentApprovalAction.Kind(rawValue: response.actionIdentifier == UNNotificationDefaultActionIdentifier ? "review" : response.actionIdentifier)
    else { return }
    let action = AgentApprovalAction(runId: runId, approvalId: approvalId, action: kind)
    await AgentActivityManager.shared.receiveApprovalAction(action)
  }
}
