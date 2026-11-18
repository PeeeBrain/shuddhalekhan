import Foundation

enum RecordingCue: String, CaseIterable {
  case start, stop, error

  // Original, short tones with the same rising, falling and minor contours as desktop.
  var wav: Data {
    let frequency: (Double, Double) = switch self {
    case .start: (520, 780)
    case .stop: (660, 440)
    case .error: (392, 330)
    }
    let sampleRate: UInt32 = 24_000
    let frames = Int(sampleRate) * 90 / 1_000
    let byteCount = UInt32(frames * MemoryLayout<Int16>.size)
    var wav = Data()
    wav.reserveCapacity(44 + Int(byteCount))
    func append(_ value: some FixedWidthInteger) {
      withUnsafeBytes(of: value.littleEndian) { wav.append(contentsOf: $0) }
    }
    wav.append(contentsOf: "RIFF".utf8)
    append(36 + byteCount)
    wav.append(contentsOf: "WAVEfmt ".utf8)
    append(UInt32(16))
    append(UInt16(1))
    append(UInt16(1))
    append(sampleRate)
    append(sampleRate * 2)
    append(UInt16(2))
    append(UInt16(16))
    wav.append(contentsOf: "data".utf8)
    append(byteCount)
    for frame in 0..<frames {
      let progress = Double(frame) / Double(frames)
      let cycles = 0.09 * progress * (frequency.0 + (frequency.1 - frequency.0) * progress / 2)
      let envelope = sin(.pi * progress)
      append(Int16(4_500 * envelope * envelope * sin(2 * .pi * cycles)))
    }
    return wav
  }
}

enum RecordingSoundPreference {
  static var enabled: Bool {
    get { UserDefaults.standard.object(forKey: "recordingSounds") == nil || UserDefaults.standard.bool(forKey: "recordingSounds") }
    set { UserDefaults.standard.set(newValue, forKey: "recordingSounds") }
  }
}
