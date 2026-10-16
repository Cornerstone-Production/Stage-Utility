import Foundation
import StageUtilityOutputCore

/// Finds the server for ONE output: probes until answered, then keeps probing slowly
/// so the server goes on listing it.
///
/// With no `server` file the probe goes to every interface's broadcast address. With
/// one it goes to that server alone, by unicast: the output still has to be heard on
/// Screens ("Not set up yet"), but there is nobody else to ask and nobody else who
/// should hear it.
@MainActor
final class OutputDiscovery {
  enum Mode {
    case broadcast
    case unicast(host: String)
  }

  private let label: String
  private let port: UInt16
  private let mode: Mode
  private let boundTo: () -> String?
  private let makeProbe: (_ unreachable: Bool) -> Data
  private var socket: ProbeSocket?
  private var timer: DispatchWorkItem?
  private var unanswered = 0
  private var answered = false
  private var running = false
  /// Across restarts, so trouble that has not changed is not said again.
  private var link = ProbeLinkState()
  private var filter = ReplyFilter()

  /// The server answered. Called on the main queue, for every answer from the server
  /// this output is bound to (or, while it is bound to none, from anyone).
  var onReply: ((DiscoveryReply) -> Void)?
  /// Every broadcast probe failed to send with "no route to host", which is what a
  /// refused Local Network permission looks like.
  var onLocalNetworkSuspected: (() -> Void)?

  init(
    label: String, port: UInt16, mode: Mode, boundTo: @escaping () -> String?,
    makeProbe: @escaping (_ unreachable: Bool) -> Data
  ) {
    self.label = label
    self.port = port
    self.mode = mode
    self.boundTo = boundTo
    self.makeProbe = makeProbe
  }

  func start() {
    guard !running else { return }
    running = true
    answered = false
    unanswered = 0
    filter = ReplyFilter()
    tick()
  }

  /// The server stopped answering: go back to probing every 2 s.
  func restart() {
    Log.notice(.discovery, "\(label): searching again")
    stop()
    start()
  }

  func stop() {
    running = false
    timer?.cancel()
    timer = nil
    socket?.close()
    socket = nil
  }

  /// Open the socket when there is none. A socket that failed to open is tried again
  /// on every tick, and the ticks are 30 s apart while there is none.
  private func ensureSocket() {
    guard socket == nil else { return }
    do {
      let s = try ProbeSocket()
      s.onDatagram = { [weak self] data in self?.heard(data) }
      socket = s
      report(link.socketOpened())
    } catch {
      report(link.socketOpenFailed("\(error)"))
    }
  }

  private func tick() {
    guard running else { return }
    ensureSocket()
    if socket != nil {
      switch mode {
      case .broadcast:
        sendProbe(to: ProbeTarget.broadcasts(), inferLocalNetworkDenial: true)
      case .unicast(let host):
        ProbeTarget.resolve(host: host) { [weak self] target in
          MainActor.assumeIsolated {
            guard let self, self.running else { return }
            self.report(self.link.resolved(host: host, ok: target != nil))
            if let target { self.sendProbe(to: [target], inferLocalNetworkDenial: false) }
          }
        }
      }
    }
    if !answered { unanswered += 1 }
    let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.tick() } }
    timer = work
    let wait = ProbeSchedule.interval(unanswered: unanswered, answered: answered, socketOpen: link.socketOpen)
    DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: work)
    if !answered, unanswered == 10 {
      Log.notice(.discovery, "\(label): no answer after 10 probes; probing every 30 s (the server lists an unclaimed output at once but answers it only while a Screens page is open, or once it is set up)")
    }
  }

  private func sendProbe(to targets: [ProbeTarget], inferLocalNetworkDenial: Bool) {
    guard let socket else { return }
    // Said to other servers only: a probe to the one server in the server file has no
    // other server to hear it.
    var unreachable = false
    if case .broadcast = mode {
      unreachable = ProbeSchedule.flagsUnreachable(unanswered: unanswered, answered: answered, boundTo: boundTo())
    }
    let failures = socket.send(makeProbe(unreachable), to: targets, port: port)
    report(link.sent(failures: failures, targets: targets.count, inferLocalNetworkDenial: inferLocalNetworkDenial))
  }

  private func report(_ event: ProbeLinkState.Event) {
    switch event {
    case .none:
      break
    case .socketUnavailable(let why):
      Log.error(.discovery, "\(label): cannot open a probe socket: \(why); trying again every 30 s")
    case .socketRestored:
      Log.notice(.discovery, "\(label): the probe socket is open again")
    case .sendFailed(let why, let likely):
      Log.error(.discovery, "\(label): every probe failed to send: \(why)")
      if likely {
        Log.error(.discovery, "\(label): this looks like Local Network access being off for the helper")
        onLocalNetworkSuspected?()
      }
    case .sendRecovered:
      Log.notice(.discovery, "\(label): probes are sending again")
    case .targetUnresolved(let host):
      Log.error(.discovery, "\(label): the server file's host \(host) does not resolve to an IPv4 address; no probe is sent")
    case .targetResolved:
      Log.notice(.discovery, "\(label): the server file's host resolves again")
    }
  }

  private func heard(_ data: Data) {
    guard let reply = DiscoveryReply.parse(data) else {
      Log.notice(.discovery, "\(label): ignored a datagram that is not a server reply (\(data.count) bytes)")
      return
    }
    let bound = boundTo()
    if case .ignore(let firstTime) = filter.decide(reply, boundTo: bound) {
      if firstTime {
        Log.error(.discovery, "\(label): ignored an answer from \"\(reply.name)\" (\(reply.serverId)) at \(Redact.url(reply.url)): this output is bound to server \(bound ?? "?"). Another host on the network may be answering for it")
      }
      return
    }
    if !answered {
      answered = true
      Log.notice(.discovery, "\(label): answered by \"\(reply.name)\" (\(reply.serverId)) at \(Redact.url(reply.url))")
    }
    onReply?(reply)
  }
}
