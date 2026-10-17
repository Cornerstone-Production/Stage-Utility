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
///
/// An output set up nowhere follows the first server that answers it, for as long as
/// discovery runs, so two servers both on their Screens page do not swap its page back
/// and forth. That is remembered here, in memory, and never put in the probe: a server
/// that merely answered has not claimed anything. Two answers break it: one that says
/// this output is set up on the server that sent it (an operator just claimed it
/// there), and the release that makes it forget its server.
public struct ReplyFilter: Equatable {
  public enum Decision: Equatable {
    /// Believed, and what it does to the server the output remembers.
    case accept(OutputBinding)
    /// Not from the server this output is bound to, or is following. `firstTime` once
    /// per run for each of the two, so the log has the line and a noisy host cannot
    /// fill it.
    case ignore(firstTime: Bool)
  }

  private var announcedBound = false
  private var announcedFollowing = false
  /// The server an unbound output is following, once one has answered.
  public private(set) var following: String?

  public init() {}

  public mutating func decide(_ reply: DiscoveryReply, boundTo: String?) -> Decision {
    if let boundTo {
      guard reply.serverId == boundTo else { return Self.ignore(&announcedBound) }
      // Released by its own server: free to follow whoever answers next.
      following = reply.claimed == false ? nil : boundTo
      return .accept(OutputBinding.change(after: reply, boundTo: boundTo))
    }
    if let following, reply.serverId != following, reply.claimed != true { return Self.ignore(&announcedFollowing) }
    following = reply.serverId
    return .accept(OutputBinding.change(after: reply, boundTo: nil))
  }

  private static func ignore(_ announced: inout Bool) -> Decision {
    defer { announced = true }
    return .ignore(firstTime: !announced)
  }
}

/// What an accepted answer does to the server an output remembers, its `boundTo`.
///
/// `boundTo` goes in every probe, and every other server ignores an output that names
/// someone else, so it must mean claimed: remembered when a server says this output is
/// set up there, forgotten when that same server says it is not (released, or claimed
/// on an install since wiped). An answer with no `claimed`, from a server older than
/// the field, is remembered.
public enum OutputBinding: Equatable {
  case keep
  case bind(String)
  case forget(String)

  public static func change(after reply: DiscoveryReply, boundTo: String?) -> OutputBinding {
    let fromBound = reply.serverId == boundTo
    switch reply.claimed {
    case .some(false): return fromBound ? .forget(reply.serverId) : .keep
    case .some(true), .none: return fromBound ? .keep : .bind(reply.serverId)
    }
  }
}
