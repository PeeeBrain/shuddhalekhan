import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct SystemDictationWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: SystemDictationAttributes.self) { context in
      HStack {
        Text(context.isStale ? "Dictation status expired" : context.state.phase.title)
        Spacer()
        actions(context)
      }
      .padding()
      .widgetURL(URL(string: "shuddhalekhan://system-dictation"))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.center) { Text(context.isStale ? "Dictation status expired" : context.state.phase.title) }
        DynamicIslandExpandedRegion(.bottom) { actions(context) }
      } compactLeading: {
        Image(systemName: "mic")
      } compactTrailing: {
        Image(systemName: !context.isStale && context.state.phase == .recording ? "waveform" : "circle")
          .accessibilityLabel(context.isStale ? "Dictation status expired" : context.state.phase.title)
      } minimal: {
        Image(systemName: "mic")
          .accessibilityLabel(context.isStale ? "Dictation status expired" : context.state.phase.title)
      }
      .widgetURL(URL(string: "shuddhalekhan://system-dictation"))
    }
  }

  @ViewBuilder private func actions(_ context: ActivityViewContext<SystemDictationAttributes>) -> some View {
    if !context.isStale && context.state.phase == .recording {
      Button(intent: FinishSystemDictation(requestID: context.attributes.requestID)) {
        Label("Stop", systemImage: "stop.fill")
      }
    }
    if !context.isStale && [.preparing, .recording, .transcribing].contains(context.state.phase) {
      Button(intent: CancelSystemDictation(requestID: context.attributes.requestID)) {
        Label("Cancel", systemImage: "xmark")
      }
    }
  }
}

@available(iOS 18.0, *)
struct SystemDictationControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "com.shuddhalekhan.mobile.dictate") {
      ControlWidgetButton(action: OpenDictationFromControl()) {
        Label("Open Dictation", systemImage: "waveform")
      }
    }
    .displayName("Shuddhalekhan Dictation")
    .description("Open Shuddhalekhan and start on-device dictation.")
  }
}
