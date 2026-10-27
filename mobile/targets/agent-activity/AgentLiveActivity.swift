import ActivityKit
import SwiftUI
import WidgetKit

@main
struct AgentActivityBundle: WidgetBundle {
  var body: some Widget {
    AgentLiveActivity()
  }
}

// Renders app-published state only. Every tap deep-links to the run; the app validates IDs and owns approval.
struct AgentLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: AgentActivityAttributes.self) { context in
      let run = AgentRun(context)
      LockScreenView(run: run)
        .widgetURL(run.url)
    } dynamicIsland: { context in
      let run = AgentRun(context)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          PhaseIcon(phase: run.phase)
            .font(.title2)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(run.phase.title)
            .font(.headline)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
        }
        DynamicIslandExpandedRegion(.bottom) {
          RunDetail(run: run)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        PhaseIcon(phase: run.phase)
      } compactTrailing: {
        Text(run.phase.shortTitle)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(run.phase.tint)
          .lineLimit(1)
      } minimal: {
        PhaseIcon(phase: run.phase)
      }
      .widgetURL(run.url)
    }
  }
}

private enum Phase: String {
  case running, awaitingApproval, completed, failed, cancelled, interrupted

  var isTerminal: Bool { self != .running && self != .awaitingApproval }

  var title: String {
    switch self {
    case .running: "Agent working"
    case .awaitingApproval: "Agent needs approval"
    case .completed: "Agent finished"
    case .failed: "Agent failed"
    case .cancelled: "Agent cancelled"
    case .interrupted: "Agent interrupted"
    }
  }

  var shortTitle: String {
    switch self {
    case .running: "Working"
    case .awaitingApproval: "Review"
    case .completed: "Done"
    case .failed: "Failed"
    case .cancelled, .interrupted: "Stopped"
    }
  }

  // Static symbols only: no symbol effects or timers, so the activity repaints on state changes alone.
  var symbol: String {
    switch self {
    case .running: "ellipsis.circle.fill"
    case .awaitingApproval: "hand.raised.fill"
    case .completed: "checkmark.circle.fill"
    case .failed: "exclamationmark.triangle.fill"
    case .cancelled: "stop.circle.fill"
    case .interrupted: "xmark.circle.fill"
    }
  }

  var tint: Color {
    switch self {
    case .running: .cyan
    case .awaitingApproval: .orange
    case .completed: .green
    case .failed: .red
    case .cancelled, .interrupted: .gray
    }
  }
}

private struct AgentRun {
  let phase: Phase
  let status: String
  let answerPreview: String?
  let isStale: Bool
  let url: URL?

  init(_ context: ActivityViewContext<AgentActivityAttributes>) {
    let state = context.state
    phase = Phase(rawValue: state.phase) ?? .running
    status = state.status
    answerPreview = phase == .completed && state.answerPreview?.isEmpty == false ? state.answerPreview : nil
    isStale = context.isStale && !phase.isTerminal

    var link = URLComponents()
    link.scheme = "shuddhalekhan"
    link.host = "agent"
    link.queryItems = [URLQueryItem(name: "runId", value: context.attributes.runId)]
    if let approvalId = state.approvalId {
      link.queryItems?.append(URLQueryItem(name: "approvalId", value: approvalId))
    }
    url = link.url
  }
}

private struct LockScreenView: View {
  let run: AgentRun

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      PhaseIcon(phase: run.phase)
        .font(.title2)
      VStack(alignment: .leading, spacing: 4) {
        Text(run.phase.title)
          .font(.headline)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
        RunDetail(run: run)
      }
      Spacer(minLength: 0)
    }
    .padding(16)
    .accessibilityElement(children: .combine)
  }
}

private struct RunDetail: View {
  let run: AgentRun

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if !run.status.isEmpty {
        Text(run.status)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(run.answerPreview == nil ? 2 : 1)
          .privacySensitive()
      }
      if let preview = run.answerPreview {
        AnswerPreview(text: preview)
      } else if run.phase == .awaitingApproval {
        Text("Tap to review in Shuddhalekhan")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(run.phase.tint)
      }
      if run.isStale {
        Text("May be out of date")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }
}

// The preview is user-requested but still Lock Screen visible: hide it whenever the system redacts private data.
private struct AnswerPreview: View {
  let text: String
  @Environment(\.redactionReasons) private var redactionReasons

  var body: some View {
    if redactionReasons.contains(.privacy) {
      Text("Answer ready. Unlock to read.")
        .font(.subheadline)
    } else {
      Text(text)
        .font(.subheadline)
        .lineLimit(3)
        .privacySensitive()
    }
  }
}

private struct PhaseIcon: View {
  let phase: Phase

  var body: some View {
    Image(systemName: phase.symbol)
      .foregroundStyle(phase.tint)
      .accessibilityHidden(true)
  }
}
