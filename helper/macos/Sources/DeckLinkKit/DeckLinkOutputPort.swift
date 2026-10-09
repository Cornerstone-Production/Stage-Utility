import DeckLinkShim
import Foundation
import StageUtilityOutputCore

/// One DeckLink port playing out, fed by a `CardFrameSource` on the card's clock.
///
/// The port's own thread asks the source for each frame two or three frames ahead
/// of air (the shim's scheduler): a source with no new picture gets the previous
/// one repeated, a card that reports a frame late or dropped is counted, and a
/// schedule that falls behind the card is moved forward instead of running late
/// for good.
///
/// A port that is unplugged, or that the driver stops, closes itself, says so in the
/// log, and tries to open again every `retryInterval` and whenever `retry()` is
/// called (on a device arriving). A mode the port cannot play is refused, and stays
/// refused until `open` is called with another.
///
/// The same port runs on a software clock (`Hardware.softwareClock`): the same
/// scheduler and counters, ticking by itself or by hand, with no card.
public final class DeckLinkOutputPort: CardSink {
  public enum Hardware {
    case port(DeckLinkPort)
    /// The scheduler on a software clock instead of a card. With
    /// `ticksByItself` false only the tests move it.
    case softwareClock(width: Int, height: Int, frameDuration: Int64, timeScale: Int64, ticksByItself: Bool)
  }

  public enum State: Equatable {
    case closed
    /// Playing out in this mode.
    case running(mode: String)
    /// The screen's mode cannot be played on this port. Not retried.
    case refused(String)
    /// Gone or failed; retried until it opens again.
    case lost(String)
  }

  public let label: String
  private let hardware: Hardware
  private let source: CardFrameSource
  private let depth: Int
  private let retryInterval: TimeInterval
  private let pollInterval: TimeInterval
  private let log: (DeckLinkLog.Level, String) -> Void
  private let clock: () -> TimeInterval
  private let queue = DispatchQueue(label: "com.stageutility.output.decklink.port")

  // Everything below is touched only on `queue`.
  private var handle: OpaquePointer?
  private var box: CallbackBox?
  private var closedCounts = CardCounters()
  private var current: State = .closed
  private var videoMode: String?
  private var trouble = CardTrouble()
  private var pollTimer: DispatchSourceTimer?
  private var retryTimer: DispatchSourceTimer?
  private var lastSample: (at: TimeInterval, counters: CardCounters)

  /// - Parameters:
  ///   - depth: frames in flight, all scheduled before playback starts.
  ///   - log: where the port's lines go; the unified log unless a test says.
  ///   - clock: seconds, for the health sample's rate.
  public init(
    label: String, hardware: Hardware, source: CardFrameSource, depth: Int = 3, retryInterval: TimeInterval = 2,
    pollInterval: TimeInterval = 1, log: @escaping (DeckLinkLog.Level, String) -> Void = DeckLinkLog.write,
    clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.label = label
    self.hardware = hardware
    self.source = source
    self.depth = depth
    self.retryInterval = retryInterval
    self.pollInterval = pollInterval
    self.log = log
    self.clock = clock
    lastSample = (clock(), CardCounters())
  }

  deinit {
    pollTimer?.cancel()
    retryTimer?.cancel()
    if let handle { dl_output_close(handle) }
  }

  public var state: State { queue.sync { current } }

  /// Open the port in the screen's `videoMode` (nil for the default, 1080p59.94).
  /// An open port is closed and opened again.
  @discardableResult
  public func open(videoMode: String?) -> State {
    queue.sync {
      stopTimers()
      closeHandle()
      self.videoMode = videoMode
      switch attempt() {
      case .opened(let mode):
        current = .running(mode: mode)
        log(.info, "\(label): opened in \(mode)")
        startPolling()
      case .refused(let why):
        current = .refused(why)
        log(.error, "\(label): refused \(videoMode ?? VideoModes.defaultMode): \(why)")
      case .failed(let why):
        current = .lost(why)
        log(.error, "\(label): could not open (\(why)); trying again every \(Int(retryInterval)) s")
        startRetrying()
      }
      return current
    }
  }

  /// Try a lost port again now: a device arrived.
  public func retry() {
    queue.async { [weak self] in self?.retryNow() }
  }

  public func close() {
    queue.sync {
      stopTimers()
      closeHandle()
      current = .closed
    }
  }

  public var counters: CardCounters { queue.sync { countsNow() } }

  public func takeHealthSample() -> HealthSample {
    queue.sync {
      let now = clock()
      let counts = countsNow()
      let elapsed = now - lastSample.at
      let sent = counts.scheduled - lastSample.counters.scheduled
      let sample = HealthSample(
        fps: elapsed > 0 ? Double(sent) / elapsed : 0,
        repeated: Int(counts.repeated - lastSample.counters.repeated),
        dropped: Int(counts.dropped - lastSample.counters.dropped))
      lastSample = (now, counts)
      return sample
    }
  }

  // MARK: On the queue

  private enum Attempt {
    case opened(String)
    case refused(String)
    case failed(String)
  }

  private func attempt() -> Attempt {
    var why = [CChar](repeating: 0, count: 256)
    let box: CallbackBox
    let opened: OpaquePointer?
    let modeName: String
    switch hardware {
    case .port(let port):
      let mode: CardMode
      switch VideoModes.resolve(videoMode, among: port.modes) {
      case .failure(let refusal): return .refused(refusal.reason)
      case .success(let m): mode = m
      }
      modeName = VideoModes.name(of: mode) ?? mode.driverName
      box = CallbackBox(source: source, timeScale: mode.timeScale, port: self)
      var id = port.id.shim
      var callbacks = box.callbacks(depth: depth)
      opened = dl_output_open(&id, mode.code, &callbacks, &why, why.count)
    case .softwareClock(let width, let height, let duration, let scale, let ticks):
      modeName = "\(width)x\(height) at \(VideoModes.rateText(Double(scale) / Double(duration))) on a software clock"
      box = CallbackBox(source: source, timeScale: scale, port: self)
      var callbacks = box.callbacks(depth: depth)
      opened = dl_fake_output_open(Int32(width), Int32(height), duration, scale, ticks, &callbacks, &why, why.count)
    }
    guard let opened else { return .failed(String(cString: why)) }
    handle = opened
    self.box = box
    // The pre-roll is filled before any page can have drawn, so its repeats are the
    // baseline, not trouble.
    trouble = CardTrouble()
    let counts = countsNow()
    _ = trouble.observe(repeated: counts.repeated, dropped: counts.dropped)
    return .opened(modeName)
  }

  private func retryNow() {
    guard case .lost = current else { return }
    switch attempt() {
    case .opened(let mode):
      current = .running(mode: mode)
      stopTimers()
      log(.info, "\(label): reopened in \(mode)")
      startPolling()
    case .refused(let why):
      current = .refused(why)
      stopTimers()
      log(.error, "\(label): refused \(videoMode ?? VideoModes.defaultMode): \(why)")
    case .failed:
      // Still gone. The line that said it was lost is enough.
      break
    }
  }

  fileprivate func lost(_ reason: String, from: CallbackBox) {
    queue.async { [weak self] in
      guard let self, from === self.box else { return }
      self.stopTimers()
      self.closeHandle()
      self.current = .lost(reason)
      self.log(.error, "\(self.label): lost (\(reason)); trying again every \(Int(self.retryInterval)) s")
      self.startRetrying()
    }
  }

  private func countsNow() -> CardCounters {
    guard let handle else { return closedCounts }
    var c = dl_counters()
    dl_output_counters(handle, &c)
    return closedCounts
      + CardCounters(scheduled: c.scheduled, repeated: c.repeated, dropped: c.dropped, resyncs: c.resyncs)
  }

  private func closeHandle() {
    guard let handle else { return }
    closedCounts = countsNow()
    dl_output_close(handle)
    self.handle = nil
    box = nil
  }

  private func startPolling() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + pollInterval, repeating: pollInterval)
    timer.setEventHandler { [weak self] in self?.pollNow() }
    timer.resume()
    pollTimer = timer
  }

  private func startRetrying() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + retryInterval, repeating: retryInterval)
    timer.setEventHandler { [weak self] in self?.retryNow() }
    timer.resume()
    retryTimer = timer
  }

  private func stopTimers() {
    pollTimer?.cancel()
    pollTimer = nil
    retryTimer?.cancel()
    retryTimer = nil
  }

  /// Log repeats and drops when they start and when they stop.
  private func pollNow() {
    guard handle != nil else { return }
    let counts = countsNow()
    for event in trouble.observe(repeated: counts.repeated, dropped: counts.dropped) {
      switch event {
      case .started(let kind, let count):
        log(.error, "\(label): \(kind.rawValue) (\(count) in the last \(Int(pollInterval)) s)")
      case .stopped(let kind, let total):
        log(.info, "\(label): stopped \(kind.rawValue) (\(total) in all)")
      }
    }
  }

  // MARK: Software clock controls, for tests

  func sync() { queue.sync {} }
  func pollForTest() { queue.sync { pollNow() } }
  func fakeTick(_ frames: Int) { queue.sync { if let handle { dl_fake_tick(handle, Int32(frames)) } } }
  func fakeHold(_ on: Bool) { queue.sync { if let handle { dl_fake_hold_completions(handle, on) } } }
  func fakeUnplug() { queue.sync { if let handle { dl_fake_unplug(handle) } } }
  func fakeShown() -> [Int64] {
    queue.sync {
      guard let handle else { return [] }
      let count = dl_fake_shown(handle, nil, 0)
      var shown = [Int64](repeating: 0, count: Int(count))
      _ = dl_fake_shown(handle, &shown, count)
      return shown
    }
  }
}

/// What the shim's callbacks get as their context: the source to ask, and the port
/// to tell. Kept alive by the port for as long as its output is open; the shim
/// calls nothing after `dl_output_close` returns.
final class CallbackBox {
  let source: CardFrameSource
  let timeScale: Int64
  weak var port: DeckLinkOutputPort?

  init(source: CardFrameSource, timeScale: Int64, port: DeckLinkOutputPort) {
    self.source = source
    self.timeScale = timeScale
    self.port = port
  }

  func callbacks(depth: Int) -> dl_callbacks {
    dl_callbacks(
      fill: fillThunk, lost: lostThunk, ctx: Unmanaged.passUnretained(self).toOpaque(), depth: Int32(depth))
  }
}

private let fillThunk: dl_fill_fn = { ctx, index, streamTime, target in
  guard let ctx, let target, let bytes = target.pointee.bytes else { return false }
  let box = Unmanaged<CallbackBox>.fromOpaque(ctx).takeUnretainedValue()
  let t = target.pointee
  return box.source.fill(
    CardFrameRequest(index: index, streamTime: streamTime, timeScale: box.timeScale),
    into: CardFrameTarget(
      bytes: bytes, length: t.length, rowBytes: Int(t.row_bytes), width: Int(t.width), height: Int(t.height),
      slot: Int(t.slot)))
}

private let lostThunk: dl_lost_fn = { ctx, reason in
  guard let ctx else { return }
  let box = Unmanaged<CallbackBox>.fromOpaque(ctx).takeUnretainedValue()
  box.port?.lost(reason.map { String(cString: $0) } ?? "no reason given", from: box)
}
