import Foundation

/// A cancelled inference must release its encoder before the next inference or model load starts.
actor SpeechWorkQueue {
  private var tail: Task<Void, Never>?

  func submit<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) -> Task<T, Error> {
    let previous = tail
    let task = Task {
      await previous?.value
      try Task.checkCancellation()
      let value = try await operation()
      try Task.checkCancellation()
      return value
    }
    tail = Task { _ = await task.result }
    return task
  }

  nonisolated func run<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    let task = await submit(operation)
    return try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }
}
