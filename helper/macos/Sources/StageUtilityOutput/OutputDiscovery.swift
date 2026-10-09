import Foundation
import StageUtilityOutputCore

/// Finds the server for ONE output: probes until answered, then keeps probing slowly
/// so the server goes on listing it.
final class OutputDiscovery {
  private let label: String
  private let port: UInt16
  private let makeProbe: () -> Data
  private var socket: ProbeSocket?
  private var timer: DispatchWorkItem?
  private var unanswered = 0
  private var answered = false
  private var running = false

  /// The server answered. Called on the main queue, for every answer.
  var onReply: ((DiscoveryReply) -> Void)?
  /// Every probe failed to send with "no route to host", which is what a refused
  /// Local Network permission looks like. Called on each such round.
  var onLocalNetworkSuspected: (() -> Void)?

  init(label: String, port: UInt16, makeProbe: @escaping () -> Data) {
    self.label = label
    self.port = port
    self.makeProbe = makeProbe
  }

  func start() {
    guard !running else { return }
    running = true
    answered = false
    unanswered = 0
    do {
      let s = try ProbeSocket()
      s.onDatagram = { [weak self] data in self?.heard(data) }
      socket = s
    } catch {
      // Nothing to probe with. Said, and tried again at the slow rate.
      Log.error(.discovery, "\(label): cannot open a probe socket: \(error)")
    }
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

  private func tick() {
    guard running else { return }
    let targets = BroadcastTarget.current()
    if let socket {
      let failures = socket.send(makeProbe(), to: targets, port: port)
      if failures.count == targets.count {
        let why = failures.map { "\($0.target): \(String(cString: strerror($0.errno)))" }.joined(separator: "; ")
        Log.error(.discovery, "\(label): every probe failed to send: \(why)")
        if LocalNetworkAccess.looksLikeDenial(sendErrors: failures.map(\.errno), targets: targets.count) {
          Log.error(.discovery, "\(label): this looks like Local Network access being off for the helper")
          onLocalNetworkSuspected?()
        }
      }
    }
    if !answered { unanswered += 1 }
    let work = DispatchWorkItem { [weak self] in self?.tick() }
    timer = work
    let wait = ProbeSchedule.interval(unanswered: unanswered, answered: answered)
    DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: work)
    if !answered, unanswered == 10 {
      Log.notice(.discovery, "\(label): no answer after 10 probes; probing every 30 s (the server answers an unclaimed output only while Screens is scanning)")
    }
  }

  private func heard(_ data: Data) {
    guard let reply = DiscoveryReply.parse(data) else {
      Log.notice(.discovery, "\(label): ignored a datagram that is not a server reply (\(data.count) bytes)")
      return
    }
    if !answered {
      answered = true
      Log.notice(.discovery, "\(label): answered by \"\(reply.name)\" (\(reply.serverId)) at \(reply.url)")
    }
    onReply?(reply)
  }
}
