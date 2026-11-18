import AVFoundation

@main
struct KeyboardUtteranceCheck {
  @MainActor static func main() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("caf")
    defer { try? FileManager.default.removeItem(at: path) }
    let sink = KeyboardUtteranceSink()
    let rate = 16_000.0
    let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
    let audio = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16)!
    audio.frameLength = 16
    let first = mach_absolute_time()
    func time(_ frame: Double) -> UInt64 { first + AVAudioTime.hostTime(forSeconds: frame / rate) }
    func append(startFrame: Int, value: (Int) -> Float) {
      for frame in 0..<16 { audio.floatChannelData![0][frame] = value(startFrame + frame) }
      sink.append(audio, time: AVAudioTime(hostTime: time(Double(startFrame))))
    }

    try sink.prepare(path, format: format)
    // Buffer starts before ready, then spans speech. Stop's buffer straddles the cutoff.
    sink.start(at: time(7.5))
    append(startFrame: 0) { $0 < 8 ? -1 : 0.25 }
    let stop = time(24.5)
    sink.markStop(at: stop)
    append(startFrame: 16) { $0 > 24 ? -1 : 0.5 }
    append(startFrame: 32) { _ in -1 }
    let saved = await sink.drain(until: stop, timeout: .milliseconds(100))
    precondition(saved, "Stop should flush the captured word before returning.")
    let file = try AVAudioFile(forReading: path)
    precondition(file.length == 17, "Record only the frames from ready through Stop.")
    try file.read(into: audio, frameCount: 16)
    precondition(audio.floatChannelData![0][0] == 0.25 && audio.floatChannelData![0][15] == 0.5)
    try file.read(into: audio, frameCount: 1)
    precondition(audio.floatChannelData![0][0] == 0.5, "Preserve the final speech sample.")
    let incomplete = path.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("caf")
    defer { try? FileManager.default.removeItem(at: incomplete) }
    try sink.prepare(incomplete, format: format)
    sink.start(at: time(7.5))
    append(startFrame: 0) { _ in 0.25 }
    sink.markStop(at: stop)
    let savedIncomplete = await sink.drain(until: stop, timeout: .zero)
    precondition(!savedIncomplete, "A missing final tap must never silently save a clipped recording.")
    print("KeyboardUtteranceCheck passed")
  }
}
