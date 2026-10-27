import Foundation

private actor Gate {
  private var opened = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if opened { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    opened = true
    for waiter in waiters { waiter.resume() }
    waiters.removeAll()
  }
}

private actor Events {
  var values: [String] = []
  func add(_ value: String) { values.append(value) }
}

@main
struct SpeechWorkCheck {
  @MainActor static func main() async throws {
    // A non-cooperative inference must finish before model replacement or the next utterance.
    let queue = SpeechWorkQueue()
    let started = Gate()
    let finish = Gate()
    let events = Events()
    let inference = await queue.submit {
      await events.add("inference started")
      await started.open()
      await finish.wait()
      await events.add("inference released")
      return "cancelled text"
    }
    await started.wait()
    inference.cancel()
    let cancelled = await queue.submit { await events.add("cancelled operation ran") }
    cancelled.cancel()
    let replacement = await queue.submit { await events.add("replacement loaded") }
    let next = await queue.submit { await events.add("next utterance") }
    let beforeRelease = await events.values
    precondition(beforeRelease == ["inference started"], "Cancelled inference released admission too early")
    await finish.open()
    switch await inference.result {
    case .failure(is CancellationError): break
    default: preconditionFailure("Cancelled inference returned stale text")
    }
    switch await cancelled.result {
    case .failure(is CancellationError): break
    default: preconditionFailure("Cancelled queued work ran")
    }
    try await replacement.value
    try await next.value
    let order = await events.values
    precondition(order == ["inference started", "inference released", "replacement loaded", "next utterance"],
      "Speech inference and encoder loads overlapped or work was lost")

    // Cancellation of an awaiting caller reaches the owned task, even if the operation ignores it.
    let running = Gate()
    let release = Gate()
    let caller = Task {
      try await queue.run { await running.open(); await release.wait(); return "late text" }
    }
    await running.wait()
    caller.cancel()
    await release.open()
    switch await caller.result {
    case .failure(is CancellationError): break
    default: preconditionFailure("Caller cancellation did not reach speech work")
    }

    // Failed removal blocks accumulation of private audio and retries before the next utterance.
    let recordings = KeyboardAudioStore()
    let url = try recordings.recordingURL()
    try Data("test audio".utf8).write(to: url)
    let directory = url.deletingLastPathComponent()
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
      recordings.remove(url)
    }
    recordings.remove(url)
    precondition(FileManager.default.fileExists(atPath: url.path), "Deletion failure fixture did not prevent removal")
    do {
      _ = try recordings.recordingURL()
      preconditionFailure("Cleanup failure admitted more private audio")
    } catch {}
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    _ = try recordings.recordingURL()
    precondition(!FileManager.default.fileExists(atPath: url.path), "Pending audio was not retried")

    // A new app process can discover and delete audio left by an interrupted cleanup.
    let stale = try recordings.recordingURL()
    try Data("stale test audio".utf8).write(to: stale)
    _ = KeyboardAudioStore()
    precondition(!FileManager.default.fileExists(atPath: stale.path), "Previous-process audio was forgotten")
    print("SpeechWorkCheck passed: cancellation, encoder admission, failed cleanup and restart recovery")
  }
}
