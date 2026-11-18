import AVFoundation
import Foundation

/// The continuous input tap writes only the frames between the ready and Stop timestamps.
final class KeyboardUtteranceSink: @unchecked Sendable {
  private let lock = NSLock()
  private var file: AVAudioFile?
  private var startsAt: UInt64?
  private var stopsAt: UInt64?
  private var stopResult: Bool?
  private var stopWaiter: CheckedContinuation<Bool, Never>?
  private var wroteAudio = false
  private var level: Float?

  func prepare(_ url: URL, format: AVAudioFormat) throws {
    let file = try AVAudioFile(
      forWriting: url, settings: format.settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    lock.withLock {
      self.file = file
      stopsAt = nil
      stopResult = nil
      wroteAudio = false
      level = nil
    }
  }

  func start(at time: UInt64) {
    lock.withLock { startsAt = time }
  }

  func markStop(at time: UInt64) {
    lock.withLock {
      stopsAt = time
      if file == nil { finishStop() }
    }
  }

  @MainActor
  func drain(until stop: UInt64, timeout: Duration) async -> Bool {
    let deadline = Task {
      do { try await Task.sleep(for: timeout) } catch { return }
      lock.withLock {
        if stopsAt == stop, stopResult == nil { finishStop(reachedStop: false) }
      }
    }
    defer { deadline.cancel() }
    return await withCheckedContinuation { waiter in
      lock.withLock {
        guard stopsAt == stop else { return waiter.resume(returning: false) }
        if let stopResult { return waiter.resume(returning: stopResult) }
        stopWaiter = waiter
      }
    }
  }

  func append(_ input: AVAudioPCMBuffer, time: AVAudioTime) {
    lock.withLock {
      guard file != nil, let startsAt, time.isHostTimeValid else { return }
      let frames = Int(input.frameLength)
      let rate = input.format.sampleRate
      func offset(_ boundary: UInt64) -> Double {
        if boundary < time.hostTime { return -AVAudioTime.seconds(forHostTime: time.hostTime - boundary) * rate }
        return AVAudioTime.seconds(forHostTime: boundary - time.hostTime) * rate
      }
      let start = Int(min(Double(frames), max(0, ceil(offset(startsAt)))))
      let stopOffset = stopsAt.map(offset)
      let end = stopOffset.map { Int(min(Double(frames), max(0, ceil($0)))) } ?? frames
      if start < end { write(input, frames: start..<end) }
      if let stopOffset, stopOffset <= Double(frames) || file == nil { finishStop() }
    }
  }

  private func write(_ input: AVAudioPCMBuffer, frames: Range<Int>) {
    guard let file else { return }
    let buffer: AVAudioPCMBuffer
    if frames == 0..<Int(input.frameLength) { buffer = input }
    else if let trimmed = Self.slice(input, frames: frames) { buffer = trimmed }
    else { self.file = nil; return }
    updateLevel(buffer)
    do {
      try file.write(from: buffer)
      wroteAudio = true
    } catch {
      self.file = nil
    }
  }

  private static func slice(_ input: AVAudioPCMBuffer, frames: Range<Int>) -> AVAudioPCMBuffer? {
    let count = AVAudioFrameCount(frames.count)
    guard let result = AVAudioPCMBuffer(pcmFormat: input.format, frameCapacity: count) else { return nil }
    result.frameLength = count
    let bytesPerFrame = Int(input.format.streamDescription.pointee.mBytesPerFrame)
    for (source, destination) in zip(
      UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList),
      UnsafeMutableAudioBufferListPointer(result.mutableAudioBufferList)
    ) {
      guard let from = source.mData, let to = destination.mData else { return nil }
      memcpy(to, from.advanced(by: frames.lowerBound * bytesPerFrame), frames.count * bytesPerFrame)
    }
    return result
  }

  private func updateLevel(_ buffer: AVAudioPCMBuffer) {
    guard let samples = buffer.floatChannelData, buffer.frameLength > 0 else { return }
    let count = Int(buffer.frameLength)
    let stride = buffer.stride
    let channels = Int(buffer.format.channelCount)
    var sum: Float = 0
    for channel in 0..<channels {
      let pointer = buffer.format.isInterleaved ? samples[0] + channel : samples[channel]
      for frame in 0..<count {
        let sample = pointer[frame * stride]
        sum += sample * sample
      }
    }
    let rms = sqrt(sum / Float(count * channels))
    let normalized = min(1, max(0, (20 * log10(max(rms, 0.000_001)) + 50) / 50))
    level = (level ?? normalized) * 0.35 + normalized * 0.65
  }

  private func finishStop(reachedStop: Bool = true) {
    let saved = close() && reachedStop
    stopResult = saved
    stopWaiter?.resume(returning: saved)
    stopWaiter = nil
  }

  private func close() -> Bool {
    let saved = file != nil && wroteAudio
    file = nil
    startsAt = nil
    level = nil
    return saved
  }

  func currentLevel() -> Float? { lock.withLock { level } }

  func discard() {
    lock.withLock {
      _ = close()
      stopsAt = nil
      stopResult = nil
      stopWaiter?.resume(returning: false)
      stopWaiter = nil
    }
  }
}
