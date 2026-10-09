import DeckLinkShim
import Foundation
import StageUtilityOutputCore

/// One DeckLink port playing out, fed by a `CardFrameSource` on the card's clock.
///
/// The shim's scheduler runs each slot at two fixed times before it goes to air: it
/// asks the source to start the slot's picture (`begin`) the head start before, and
/// fills the slot with the newest picture (`fill`) the fill lead before. A source
/// with no new picture by then gets the previous one repeated, a card that reports
/// a frame late or dropped is counted, and a slot that cannot be filled in time is
/// skipped, the card holding its picture, rather than sent late.
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
    /// `ticksByItself` false only the tests move it. With `refusesHelperFrames`
    /// it refuses the helper's own frames, as a driver that will not take
    /// application memory would; with `makesNoFrames` it will not make its own; it
    /// needs a frame `minLeadMs` before its slot; with `countsFrames` the frames it
    /// makes are counted; with `clockUnknown` it cannot say where its playback is
    /// (`dl_fake_behaviour`).
    case softwareClock(
      width: Int, height: Int, frameDuration: Int64, timeScale: Int64, ticksByItself: Bool,
      refusesHelperFrames: Bool = false, makesNoFrames: Bool = false, minLeadMs: Double = 0,
      countsFrames: Bool = false, clockUnknown: Bool = false)
    /// A port with no card that offers every mode the server lists
    /// (`VideoModes.standard`): the software clock, ticking by itself, at the
    /// geometry and rate of whichever mode it is opened in. A `--virtual-sdi`
    /// output.
    case virtual
  }

  /// Which frames carry the pictures to the card. Either way the source copies the
  /// picture straight in.
  public enum Frames: String, Equatable {
    /// Frames the card made (CreateVideoFrame): what a port asks for. The driver
    /// takes them steadily.
    case card = "the card's frames"
    /// Frames of the helper's own memory, which the driver has to map as it takes
    /// each one: on an 8K Pro that stalled ScheduleVideoFrame for up to 38 ms now
    /// and then. Used when the card will not make frames, or when asked for.
    case helper = "the helper's frames"
  }

  public enum State: Equatable {
    case closed
    /// Playing out in this mode, in these frames.
    case running(mode: String, frames: Frames)
    /// The screen's mode cannot be played on this port. Not retried.
    case refused(String)
    /// Gone or failed; retried until it opens again.
    case lost(String)
  }

  public let label: String
  private let hardware: Hardware
  private let preferredFrames: Frames
  /// A switch to the other frames is said once per port, not on every reopening.
  private var saidSwitch = false
  /// Likewise a clock thread that could not be made real-time, and a card that
  /// would not say where its playback is.
  private var saidNotRealtime = false
  private var saidClockUnknown = false
  private let source: CardFrameSource
  private let depth: Int
  private let leads: CardLeads
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
  private var watch = CardWatch()
  private var stalled: (() -> Void)?
  /// Polls in a row in which a running port sent nothing.
  private var stalledPolls = 0
  /// The counts at the last poll, or at the open that came after it.
  private var lastPolled = CardCounters()
  private var pollTimer: DispatchSourceTimer?
  private var retryTimer: DispatchSourceTimer?
  private var lastSample: (at: TimeInterval, counters: CardCounters)
  private var openSize: (width: Int, height: Int)?
  /// Render to air of each new picture sent since the last health sample, ms.
  private var sampleLatencies: [Double] = []
  /// The latency the log last gave, ms.
  private var loggedLatency: Double?
  private var timingsHandler: (([FrameTiming]) -> Void)?
  private var timingBuffer = [dl_frame_timing](repeating: dl_frame_timing(), count: Int(DL_TIMINGS_KEPT))

  /// - Parameters:
  ///   - depth: frames of memory (see `dl_callbacks.depth`); not a delay.
  ///   - leads: when each slot's picture is asked for and when it is filled.
  ///   - frames: the frames to send in; a card that will not have them gets the
  ///     other kind.
  ///   - log: where the port's lines go; the unified log unless a test says.
  ///   - clock: seconds, for the health sample's rate.
  public init(
    label: String, hardware: Hardware, source: CardFrameSource, depth: Int = 3, leads: CardLeads = .standard,
    frames: Frames = .card, retryInterval: TimeInterval = 2,
    pollInterval: TimeInterval = 1, log: @escaping (DeckLinkLog.Level, String) -> Void = DeckLinkLog.write,
    clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.label = label
    self.hardware = hardware
    preferredFrames = frames
    self.source = source
    self.depth = depth
    self.leads = leads
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

  /// The frame size of the mode it last opened in; nil before it has opened.
  /// A browser feeding it lays out at this size (turned, for a quarter turn).
  public var frameSize: (width: Int, height: Int)? { queue.sync { openSize } }

  /// Which frames the port is sending in; nil when it is not running.
  public var frames: Frames? {
    if case .running(_, let frames) = state { return frames }
    return nil
  }

  /// Open the port in the screen's `videoMode` (nil for the default, 1080p59.94).
  /// An open port is closed and opened again.
  @discardableResult
  public func open(videoMode: String?) -> State {
    queue.sync {
      stopTimers()
      closeHandle()
      self.videoMode = videoMode
      openNow(retrying: false)
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

  /// Called on the port's own queue when the source has had no new picture for
  /// `CardWatch.stallSeconds`, once per stall: for a browser, the cue to reload
  /// its page. Hop to the owner's thread to act on it.
  public var onSourceStalled: (() -> Void)? {
    get { queue.sync { stalled } }
    set { queue.sync { stalled = newValue } }
  }

  /// Every slot's timing as the port collects them, once a second, on the port's
  /// queue: for a bench or a timing log. Nil to stop.
  public var onTimings: (([FrameTiming]) -> Void)? {
    get { queue.sync { timingsHandler } }
    set { queue.sync { timingsHandler = newValue } }
  }

  public func takeHealthSample() -> HealthSample {
    queue.sync {
      drainTimings()
      let now = clock()
      let counts = countsNow()
      var sample = HealthSample.card(
        sent: counts.scheduled - lastSample.counters.scheduled,
        repeated: counts.repeated - lastSample.counters.repeated, droppedSinceOpened: counts.missed,
        seconds: now - lastSample.at)
      let latency = Distribution.of(sampleLatencies)
      sample.latencyMs = latency?.p50
      sampleLatencies.removeAll(keepingCapacity: true)
      lastSample = (now, counts)
      if let latency, LatencyLog.worthSaying(latency.p50, after: loggedLatency) {
        loggedLatency = latency.p50
        log(.info, "\(label): render to air \(latency.text) over \(latency.count) new pictures")
      }
      return sample
    }
  }

  // MARK: On the queue

  private enum Attempt {
    case opened(String, Frames)
    case refused(String)
    case failed(String)
  }

  /// Open, and say how it went: the one path for a first open and a lost port's
  /// retry. A retry that fails again says nothing more; the line that said the port
  /// was lost is enough, and its timer keeps trying.
  private func openNow(retrying: Bool) {
    switch attempt() {
    case .opened(let mode, let frames):
      stopTimers()
      current = .running(mode: mode, frames: frames)
      log(
        .info,
        "\(label): \(retrying ? "reopened" : "opened") in \(mode)\(frames == .helper ? " with the helper's frames" : "")\(leads.text)"
      )
      startPolling()
    case .refused(let why):
      stopTimers()
      current = .refused(why)
      log(.error, "\(label): refused \(videoMode ?? VideoModes.defaultMode): \(why)")
    case .failed(let why):
      current = .lost(why)
      guard !retrying else { return }
      log(.error, "\(label): could not open (\(why)); trying again every \(Int(retryInterval)) s")
      startRetrying()
    }
  }

  /// What opening the hardware takes: the mode's name for the log, its frame size
  /// and time scale, and the call that opens it with the callbacks.
  private struct Plan {
    var modeName: String
    var width: Int
    var height: Int
    var timeScale: Int64
    var open: (UnsafePointer<dl_callbacks>, UnsafeMutablePointer<CChar>, Int) -> OpaquePointer?
  }

  private func plan() -> Result<Plan, ModeRefusal> {
    switch hardware {
    case .port(let port):
      return VideoModes.resolve(videoMode, among: port.modes).map { mode in
        Plan(
          modeName: VideoModes.name(of: mode) ?? mode.driverName, width: mode.width, height: mode.height,
          timeScale: mode.timeScale
        ) { callbacks, why, length in
          var id = port.id.shim
          return dl_output_open(&id, mode.code, callbacks, why, length)
        }
      }
    case .virtual:
      return VideoModes.resolve(videoMode, among: VideoModes.standard).map { mode in
        Self.softwarePlan(
          name: "\(mode.driverName) on a software clock", width: mode.width, height: mode.height,
          frameDuration: mode.frameDuration, timeScale: mode.timeScale,
          behaviour: dl_fake_behaviour(
            timer: true, refuse_helper_frames: false, make_no_frames: false, min_lead_us: 0, count_frames: false,
            clock_unknown: false))
      }
    case .softwareClock(
      let width, let height, let duration, let scale, let ticks, let refuses, let noFrames, let lead, let counts,
      let unknown):
      return .success(
        Self.softwarePlan(
          name: "\(width)x\(height) at \(VideoModes.rateText(Double(scale) / Double(duration))) on a software clock",
          width: width, height: height, frameDuration: duration, timeScale: scale,
          behaviour: dl_fake_behaviour(
            timer: ticks, refuse_helper_frames: refuses, make_no_frames: noFrames, min_lead_us: Int64(lead * 1000),
            count_frames: counts, clock_unknown: unknown)))
    }
  }

  private static func softwarePlan(
    name: String, width: Int, height: Int, frameDuration: Int64, timeScale: Int64, behaviour: dl_fake_behaviour
  ) -> Plan {
    Plan(modeName: name, width: width, height: height, timeScale: timeScale) { callbacks, why, length in
      var behaviour = behaviour
      return dl_fake_output_open(
        Int32(width), Int32(height), frameDuration, timeScale, &behaviour, callbacks, why, length)
    }
  }

  private func attempt() -> Attempt {
    let plan: Plan
    switch self.plan() {
    case .failure(let refusal): return .refused(refusal.reason)
    case .success(let p): plan = p
    }
    let box = CallbackBox(source: source, timeScale: plan.timeScale, port: self, queue: queue)
    var callbacks = box.callbacks(depth: depth, leads: leads, frames: preferredFrames)
    var why = [CChar](repeating: 0, count: 256)
    let opened = why.withUnsafeMutableBufferPointer { buffer in
      plan.open(&callbacks, buffer.baseAddress!, buffer.count)
    }
    guard let opened else { return .failed(String(cString: why)) }
    handle = opened
    self.box = box
    openSize = (plan.width, plan.height)
    let frames: Frames = dl_output_frames(opened) == DL_FRAMES_CARD ? .card : .helper
    if frames != preferredFrames, !saidSwitch {
      saidSwitch = true
      log(
        .info,
        frames == .card
          ? "\(label): the card refused the helper's own frames, so it gets the card's frames"
          : "\(label): the card would not make frames of its own, so it gets the helper's frames")
    }
    // The pre-roll is filled before the clock runs, so its repeats are the
    // baseline, not falling behind. Being behind goes on across a reopening.
    lastPolled = countsNow()
    stalledPolls = 0
    return .opened(plan.modeName, frames)
  }

  private func retryNow() {
    guard case .lost = current else { return }
    openNow(retrying: true)
  }

  /// On the queue. `from` is the output the news is about: a loss reported by an
  /// output already closed and replaced is old news.
  fileprivate func handleLost(_ reason: String, from: CallbackBox?) {
    guard from == nil || from === box, handle != nil else { return }
    stopTimers()
    closeHandle()
    current = .lost(reason)
    log(.error, "\(label): lost (\(reason)); trying again every \(Int(retryInterval)) s")
    startRetrying()
  }

  private func countsNow() -> CardCounters {
    guard let handle else { return closedCounts }
    var c = dl_counters()
    dl_output_counters(handle, &c)
    return closedCounts
      + CardCounters(
        scheduled: c.scheduled, repeated: c.repeated, dropped: c.dropped, resyncs: c.resyncs, skipped: c.skipped)
  }

  /// Collect the slots the shim has finished: the new pictures' render to air for
  /// the next health sample, and every slot for `onTimings`.
  private func drainTimings() {
    guard let handle else { return }
    var batch: [FrameTiming] = []
    while true {
      let n = timingBuffer.withUnsafeMutableBufferPointer {
        Int(dl_output_take_timings(handle, $0.baseAddress, Int32($0.count)))
      }
      if n == 0 { break }
      batch.append(contentsOf: timingBuffer[0..<n].map(FrameTiming.init))
    }
    guard !batch.isEmpty else { return }
    // New pictures the card showed on time: one it showed late or dropped did not
    // go out when its time says.
    for t in batch where t.fresh && !t.skipped && t.result == 0 {
      if let ms = t.renderToAirMs { sampleLatencies.append(ms) }
    }
    timingsHandler?(batch)
  }

  private func closeHandle() {
    guard let handle else { return }
    drainTimings()
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

  /// Polls with nothing sent before a running port counts as lost.
  static let stallPolls = 2

  /// Once a second: log falling behind and catching up (`CardWatch`, the server's
  /// own 5% and any-drop line), report a source that has stopped drawing, and treat
  /// a port that has stopped taking frames as lost: a card that goes silent without
  /// reporting anything would otherwise sit frozen with no line in the log.
  private func pollNow() {
    guard let handle else { return }
    drainTimings()
    var raw = dl_counters()
    dl_output_counters(handle, &raw)
    if raw.clock_not_realtime, !saidNotRealtime {
      saidNotRealtime = true
      log(.error, "\(label): macOS would not make its clock thread real-time, so frames may be filled late and repeat")
    }
    if raw.clock_unknown, !saidClockUnknown {
      saidClockUnknown = true
      log(.error, "\(label): the card would not say where its playback is, so no frame could be timed")
    }
    let counts = countsNow()
    let sent = counts.scheduled - lastPolled.scheduled
    let repeated = counts.repeated - lastPolled.repeated
    let missed = counts.missed - lastPolled.missed
    lastPolled = counts
    stalledPolls = sent == 0 ? stalledPolls + 1 : 0
    if stalledPolls >= Self.stallPolls {
      handleLost("the card stopped taking frames", from: nil)
      return
    }
    for event in watch.second(sent: Int(sent), repeated: Int(repeated), dropped: Int(missed)) {
      switch event {
      case .fellBehind(let r, let d):
        log(.error, "\(label): falling behind: \(r) repeated and \(d) dropped in the last second")
      case .caughtUp(let seconds):
        log(.info, "\(label): keeping up again after \(seconds) s")
      case .stalled:
        // The owner says what it does about it.
        stalled?()
      }
    }
  }

  // MARK: Software clock controls, for tests

  func sync() { queue.sync {} }
  func pollForTest() { queue.sync { pollNow() } }
  func fakeTick(_ frames: Int) { queue.sync { if let handle { dl_fake_tick(handle, Int32(frames)) } } }
  func fakeHold(_ on: Bool) { queue.sync { if let handle { dl_fake_hold_completions(handle, on) } } }
  func fakeReportLate(_ frames: Int) { queue.sync { if let handle { dl_fake_report_late(handle, Int32(frames)) } } }
  func fakeUnplug() { queue.sync { if let handle { dl_fake_unplug(handle) } } }
  func timingsForTest() -> [FrameTiming] {
    queue.sync {
      var all: [FrameTiming] = []
      let saved = timingsHandler
      timingsHandler = { all.append(contentsOf: $0) }
      drainTimings()
      timingsHandler = saved
      return all
    }
  }
  func fakeClockReads() -> Int64 { queue.sync { handle.map { dl_fake_clock_reads($0) } ?? 0 } }
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
///
/// The port is reached only on its own queue. Taking a strong reference to it on
/// the card's thread could make that thread the one that frees it, and the port's
/// deinit closes the output: from inside a completion that waits on itself.
final class CallbackBox {
  let source: CardFrameSource
  let timeScale: Int64
  let queue: DispatchQueue
  weak var port: DeckLinkOutputPort?

  init(source: CardFrameSource, timeScale: Int64, port: DeckLinkOutputPort, queue: DispatchQueue) {
    self.source = source
    self.timeScale = timeScale
    self.port = port
    self.queue = queue
  }

  func callbacks(depth: Int, leads: CardLeads, frames: DeckLinkOutputPort.Frames) -> dl_callbacks {
    dl_callbacks(
      fill: fillThunk, lost: lostThunk, ctx: Unmanaged.passUnretained(self).toOpaque(), depth: Int32(depth),
      card_frames: frames == .card, begin: beginThunk, head_start_us: Int64(leads.headStartMs * 1000),
      fill_lead_us: Int64(leads.fillLeadMs * 1000))
  }
}

private let fillThunk: dl_fill_fn = { ctx, index, streamTime, target in
  guard let ctx, let target, let bytes = target.pointee.bytes else { return false }
  let box = Unmanaged<CallbackBox>.fromOpaque(ctx).takeUnretainedValue()
  let t = target.pointee
  guard
    let picture = box.source.fill(
      CardFrameRequest(index: index, streamTime: streamTime, timeScale: box.timeScale),
      into: CardFrameTarget(
        bytes: bytes, length: t.length, rowBytes: Int(t.row_bytes), width: Int(t.width), height: Int(t.height),
        slot: Int(t.slot)))
  else { return false }
  target.pointee.content_ns = picture.contentNs
  target.pointee.paint_ns = picture.paintNs
  target.pointee.ready_ns = picture.readyNs
  return true
}

private let beginThunk: dl_begin_fn = { ctx, index, streamTime in
  guard let ctx else { return }
  let box = Unmanaged<CallbackBox>.fromOpaque(ctx).takeUnretainedValue()
  box.source.begin(CardFrameRequest(index: index, streamTime: streamTime, timeScale: box.timeScale))
}

/// When each slot's picture is asked for, and when the slot is filled, before it
/// goes to air. The default is what the latency measurements in DECKLINK.md chose.
public struct CardLeads: Equatable, Sendable {
  public var headStartMs: Double
  public var fillLeadMs: Double

  public init(headStartMs: Double, fillLeadMs: Double) {
    self.headStartMs = headStartMs
    self.fillLeadMs = fillLeadMs
  }

  public static let standard = CardLeads(
    headStartMs: Double(DL_DEFAULT_HEAD_START_US) / 1000, fillLeadMs: Double(DL_DEFAULT_FILL_LEAD_US) / 1000)

  /// For the open line, when they are not the standard ones: "; pictures asked for
  /// 16 ms and filled 4 ms before air".
  var text: String {
    self == .standard
      ? "" : String(format: "; pictures asked for %g ms and filled %g ms before air", headStartMs, fillLeadMs)
  }
}

extension FrameTiming {
  init(_ t: dl_frame_timing) {
    self.init(
      index: t.index, fresh: t.fresh, skipped: t.skipped, result: Int(t.result), contentNs: t.content_ns,
      paintNs: t.paint_ns, readyNs: t.ready_ns, fillNs: t.fill_ns, copiedNs: t.copied_ns, scheduledNs: t.scheduled_ns,
      airNs: t.air_ns,
      completedNs: t.completed_ns)
  }
}

private let lostThunk: dl_lost_fn = { ctx, reason in
  guard let ctx else { return }
  let box = Unmanaged<CallbackBox>.fromOpaque(ctx).takeUnretainedValue()
  let text = reason.map { String(cString: $0) } ?? "no reason given"
  box.queue.async { [box] in box.port?.handleLost(text, from: box) }
}
