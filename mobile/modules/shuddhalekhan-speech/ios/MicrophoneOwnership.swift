import Foundation

enum MicrophoneError: LocalizedError {
  case busy

  var errorDescription: String? { "Finish the current recording or stop the keyboard session, then try again." }
}

@MainActor
final class MicrophoneOwnership {
  enum Owner: Equatable { case foreground, keyboard, system }
  struct Lease: Equatable {
    let owner: Owner
    fileprivate let generation: UInt64
  }

  static let shared = MicrophoneOwnership()
  private var generation: UInt64 = 0
  private var current: Lease?
  var owner: Owner? { current?.owner }

  func claim(_ owner: Owner) throws -> Lease {
    guard current == nil else { throw MicrophoneError.busy }
    generation += 1
    let lease = Lease(owner: owner, generation: generation)
    current = lease
    return lease
  }

  func release(_ lease: Lease) {
    if current == lease { current = nil }
  }
}
