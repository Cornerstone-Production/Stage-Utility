import Foundation

/// One probe send that did not go: where, and the POSIX error.
public struct SendFailure: Equatable {
  public var target: String
  public var errno: Int32

  public init(target: String, errno: Int32) {
    self.target = target
    self.errno = errno
  }
}

/// What a probe sender is able to do, and what is worth saying when that changes.
///
/// Said on the CHANGE, not on every probe: a probe every 2 s that logs each time its
/// socket is still missing, or each time every send still fails, buries everything
/// else in the log. Each event comes once per run of the same trouble, and again when
/// the trouble ends.
public struct ProbeLinkState: Equatable {
  public enum Event: Equatable {
    case none
    case socketUnavailable(String)
    case socketRestored
    /// Every send failed. `localNetworkLikely` when the failure is the one a refused
    /// Local Network permission gives.
    case sendFailed(why: String, localNetworkLikely: Bool)
    case sendRecovered
    /// The server file's host did not resolve to an address.
    case targetUnresolved(String)
    case targetResolved
  }

  private enum Socket { case unknown, open, down }
  private enum Send: Equatable { case fine, failing(localNetwork: Bool) }
  private var socket = Socket.unknown
  private var send = Send.fine
  private var unresolved = false

  public init() {}

  public var socketOpen: Bool { socket != .down }

  public mutating func socketOpenFailed(_ reason: String) -> Event {
    if socket == .down { return .none }
    socket = .down
    return .socketUnavailable(reason)
  }

  public mutating func socketOpened() -> Event {
    let was = socket
    socket = .open
    return was == .down ? .socketRestored : .none
  }

  public mutating func resolved(host: String, ok: Bool) -> Event {
    if ok {
      let was = unresolved
      unresolved = false
      return was ? .targetResolved : .none
    }
    if unresolved { return .none }
    unresolved = true
    return .targetUnresolved(host)
  }

  /// The result of sending one probe to `targets` targets.
  ///
  /// Only a send that failed on EVERY target is trouble, and only a broadcast one can
  /// be read as a refused permission: one dead interface among working ones is
  /// nothing, and a unicast "no route to host" is a powered-off server on the same
  /// subnet as often as it is anything else (`inferLocalNetworkDenial: false`).
  public mutating func sent(failures: [SendFailure], targets: Int, inferLocalNetworkDenial: Bool) -> Event {
    guard targets > 0, failures.count == targets else {
      let was = send
      send = .fine
      return was == .fine ? .none : .sendRecovered
    }
    let denial = inferLocalNetworkDenial && failures.allSatisfy { LocalNetworkAccess.looksLikeDenial(posix: $0.errno) }
    let now = Send.failing(localNetwork: denial)
    if send == now { return .none }
    send = now
    let why = failures.map { "\($0.target): \(String(cString: strerror($0.errno)))" }.joined(separator: "; ")
    return .sendFailed(why: why, localNetworkLikely: denial)
  }
}

/// Whether to believe an answer to a probe.
///
/// Anything on the LAN can answer a broadcast. Once an output is bound to a server it
/// listens to that server alone: another host's answer would hand it a different
/// address to load, and with it the output's token, in the URL.
public struct ReplyFilter: Equatable {
  public enum Decision: Equatable {
    case accept
    /// Not from the server this output is bound to. `firstTime` once per run, so the
    /// log has the line and a noisy host cannot fill it.
    case ignore(firstTime: Bool)
  }

  private var announced = false

  public init() {}

  public mutating func decide(_ reply: DiscoveryReply, boundTo: String?) -> Decision {
    guard let boundTo, reply.serverId != boundTo else { return .accept }
    defer { announced = true }
    return .ignore(firstTime: !announced)
  }
}
