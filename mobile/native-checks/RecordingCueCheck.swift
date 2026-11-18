import AVFoundation
import Foundation

@main
struct RecordingCueCheck {
  static func main() throws {
    let defaults = UserDefaults.standard
    let original = defaults.object(forKey: "recordingSounds")
    defer { defaults.set(original, forKey: "recordingSounds") }
    defaults.removeObject(forKey: "recordingSounds")
    precondition(RecordingSoundPreference.enabled, "Cues default on for upgrades.")
    RecordingSoundPreference.enabled = false
    precondition(!RecordingSoundPreference.enabled, "Mute must survive a new settings read.")
    RecordingSoundPreference.enabled = true
    precondition(RecordingSoundPreference.enabled, "Recording sounds can be turned back on.")

    for cue in RecordingCue.allCases {
      let player = try AVAudioPlayer(data: cue.wav)
      precondition(player.duration > 0 && player.duration <= 0.1, "Cues must stay short.")
    }
    var start = RecordingStartDrain.playing(.milliseconds(75))
    precondition(start.onMute == .stopAndDrain, "Muting stops Start immediately and still drains queued audio.")
    precondition(start.playbackEnded() == .milliseconds(75))
    precondition(start.onMute == .keepDraining, "Muting an existing drain must not open the microphone early.")
    precondition(start.playbackEnded() == nil, "A repeated playback completion cannot restart the drain.")
    print("RecordingCueCheck passed")
  }
}
