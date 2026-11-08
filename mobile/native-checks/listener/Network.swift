import Foundation

// Controlled Network.framework callbacks for compiling the real server in an isolated native check.
public enum NWEndpoint: Sendable {
  public struct Port: Sendable {
    public let rawValue: UInt16
    public static let any = Port(rawValue: 0)
  }
  case hostPort(host: String, port: Port)
}

public final class NWParameters {
  public static var tcp: NWParameters { NWParameters() }
  public var requiredLocalEndpoint: NWEndpoint?
}

public struct NWError: Error { public init() {} }

public final class NWConnection: Sendable {
  public func cancel() {}
}

@MainActor
public final class NWListener {
  public enum State: Sendable { case ready, failed(NWError) }
  public let port: NWEndpoint.Port? = .any
  public var stateUpdateHandler: (@Sendable (State) -> Void)?
  public var newConnectionHandler: (@Sendable (NWConnection) -> Void)?
  private var queuedStateUpdate: (@Sendable (State) -> Void)?
  private static var waiting: CheckedContinuation<NWListener, Never>?

  public init(using parameters: NWParameters) throws {}

  public func start(queue: DispatchQueue) {
    queuedStateUpdate = stateUpdateHandler
    precondition(Self.waiting != nil, "Check must await listener creation before starting it")
    Self.waiting?.resume(returning: self)
    Self.waiting = nil
  }

  public func cancel() {}

  @MainActor public static func nextStarted() async -> NWListener {
    await withCheckedContinuation { waiting = $0 }
  }

  @MainActor public func deliverQueued(_ state: State) { queuedStateUpdate?(state) }
}
