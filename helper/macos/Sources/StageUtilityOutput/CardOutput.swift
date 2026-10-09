import AppKit
import IOSurface
import StageUtilityCEFHostAPI
import StageUtilityOutputCore
import os

/// Where a card output's frames go, and the clock that asks for them. A DeckLink
/// port (the DeckLink layer, next) clocks from its own scheduled playback; `NullCardSink` stands in
/// for one with a software clock and sends nothing anywhere.
protocol CardSink: AnyObject, Sendable {
  /// Start calling `slot` on the card's clock, from the card's own queue, with how
  /// many slots have passed since the last call (1 on time).
  func start(slot: @escaping @Sendable (_ elapsed: Int) -> Void)
  /// The page's newest picture, for the next slot. Called on the main thread inside
  /// the paint callback: the surface is invalid once this returns, so it is blitted
  /// or copied here.
  func accept(_ surface: IOSurfaceRef)
  /// The slot now due goes out with this: the newest picture, or the last again.
  func send(_ fill: FrameLedger.Fill)
  /// Stop the clock. No `slot` call runs after this returns.
  func stop()
}

/// A card with nothing behind it: a 59.94 Hz software clock (1001/60000 s, the
/// rate a 1080p59.94 port runs at) that takes each picture and sends it nowhere. It
/// runs the whole card path, scheduler, accounting and health, with no card.
final class NullCardSink: CardSink, @unchecked Sendable {
  static let slotSeconds = 1001.0 / 60000.0

  private let queue = DispatchQueue(label: "com.stageutility.output.null-card", qos: .userInteractive)
  private var timer: DispatchSourceTimer?

  func start(slot: @escaping @Sendable (Int) -> Void) {
    let t = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
    let period = DispatchTimeInterval.nanoseconds(Int((NullCardSink.slotSeconds * 1e9).rounded()))
    t.schedule(deadline: .now() + period, repeating: period, leeway: .nanoseconds(0))
    // A timer's data is how many times it fired since the handler last ran: more
    // than 1 when the queue was held up, which is the clock falling behind.
    t.setEventHandler { [weak t] in slot(max(1, Int(t?.data ?? 1))) }
    timer = t
    t.resume()
  }

  func accept(_ surface: IOSurfaceRef) {}
  func send(_ fill: FrameLedger.Fill) {}

  func stop() {
    timer?.cancel()
    timer = nil
    // A handler already running finishes before this returns.
    queue.sync {}
  }
}

/// Runs one card output: at each slot of the card's clock it sends what is due and
/// asks the page for the next frame; each frame the page draws goes to the card.
/// Counts every slot (`FrameLedger`) and logs when the output falls behind or
/// catches up, on the change only.
final class FrameScheduler: @unchecked Sendable {
  private struct State {
    var ledger = FrameLedger()
    var lag = LagWatch()
    /// The page has drawn its first picture. Before it, the browser is still being
    /// made and every slot repeats by necessity, which is not falling behind.
    var drawing = false
    var secondSlots = 0
    var secondRepeated = 0
    var secondDropped = 0
  }

  private let label: String
  private let api: UnsafePointer<su_cef_api>
  private let browser: OpaquePointer
  private let card: CardSink
  private let state = OSAllocatedUnfairLock(initialState: State())
  /// The page has drawn nothing for `FrameLedger.stallSlots`: on the main thread.
  var onStall: (@MainActor () -> Void)?

  init(label: String, api: UnsafePointer<su_cef_api>, browser: OpaquePointer, card: CardSink) {
    self.label = label
    self.api = api
    self.browser = browser
    self.card = card
  }

  func start() { card.start { [self] elapsed in slot(elapsed) } }

  /// Stops the clock; nothing calls the browser after this returns.
  func stop() { card.stop() }

  /// On the card's queue.
  private func slot(_ elapsed: Int) {
    let (fill, stalled, lagEvent) = state.withLock { s -> (FrameLedger.Fill, Bool, LagWatch.Event) in
      let fill = s.ledger.slotsDue(elapsed)
      if !s.drawing {
        s.drawing = fill == .new
        return (fill, false, .none)
      }
      s.secondSlots += elapsed
      s.secondDropped += elapsed - 1
      if fill == .repeated { s.secondRepeated += 1 }
      var event = LagWatch.Event.none
      if s.secondSlots >= 60 {
        event = s.lag.second(repeated: s.secondRepeated, dropped: s.secondDropped)
        s.secondSlots = 0
        s.secondRepeated = 0
        s.secondDropped = 0
      }
      return (fill, s.ledger.justStalled, event)
    }
    card.send(fill)
    api.pointee.begin_frame!(browser)
    switch lagEvent {
    case .none: break
    case .fellBehind(let repeated, let dropped):
      Log.error(.output, "\(label): falling behind: \(repeated) repeated and \(dropped) dropped in the last second")
    case .caughtUp(let seconds):
      Log.notice(.output, "\(label): keeping up again after \(seconds) s")
    }
    if stalled {
      DispatchQueue.main.async { [self] in MainActor.assumeIsolated { onStall?() } }
    }
  }

  /// On the main thread, inside the paint callback.
  func pictureArrived(_ surface: IOSurfaceRef) {
    state.withLock { $0.ledger.pictureArrived() }
    card.accept(surface)
  }

  func takeSample(seconds: TimeInterval) -> HealthSample {
    state.withLock { $0.ledger.takeSample(seconds: seconds) }
  }
}

/// An output that is a card port: a windowless page, laid out at the port's frame
/// size (portrait for a quarter turn), whose frames go to the card on the card's
/// clock.
@MainActor
final class CardOutput: OutputSink {
  static let frameSize = CGSize(width: 1920, height: 1080)

  let descriptor: OutputDescriptor
  let surface: WebSurface
  private let scheduler: FrameScheduler?
  private var rotation: Rotation = .none
  private var sampleStart = CACurrentMediaTime()
  /// Keeps App Nap from slowing the clock while any card output runs: the helper
  /// is an agent app and may have no window on screen at all.
  private let activity: NSObjectProtocol

  init(descriptor: OutputDescriptor, card: CardSink) {
    self.descriptor = descriptor
    activity = ProcessInfo.processInfo.beginActivity(
      options: [.userInitiated, .latencyCritical], reason: "\(descriptor.port) sends frames on a clock")
    guard let api = CEFEngine.api else {
      surface = DeadSurface(size: CardOutput.frameSize)
      scheduler = nil
      return
    }
    let page = CEFWindowlessSurface(api: api, label: descriptor.port, size: CardOutput.frameSize)
    surface = page
    guard let browser = page.handle else {
      scheduler = nil
      return
    }
    let scheduler = FrameScheduler(label: descriptor.port, api: api, browser: browser, card: card)
    self.scheduler = scheduler
    page.onPicture = { surface in scheduler.pictureArrived(surface) }
    let port = descriptor.port
    scheduler.onStall = { [weak page] in
      Log.error(.output, "\(port): the page has drawn nothing for \(FrameLedger.stallSlots) frames; reloading it")
      page?.reload()
    }
    scheduler.start()
  }

  func show(url: URL) { surface.load(url) }

  func stop() {
    // The clock first: it calls the browser, which `surface.stop()` frees.
    scheduler?.stop()
    surface.stop()
    ProcessInfo.processInfo.endActivity(activity)
  }

  func takeHealthSample() -> HealthSample {
    let now = CACurrentMediaTime()
    let seconds = now - sampleStart
    sampleStart = now
    return scheduler?.takeSample(seconds: seconds) ?? HealthSample(fps: 0)
  }

  /// The page lays out at the turned size; the card's frames are turned back
  /// (by the DeckLink layer, in Metal). Until then the dump is turned instead.
  func setRotation(_ new: Rotation) {
    rotation = new
    let size = new.swapsAxes ? CGSize(width: CardOutput.frameSize.height, height: CardOutput.frameSize.width) : CardOutput.frameSize
    (surface as? CEFWindowlessSurface)?.resize(to: size)
  }

  func writeSnapshot(to file: URL, completion: @escaping (String?) -> Void) {
    SnapshotTurn.write(surface, turnedBy: rotation, to: file, completion: completion)
  }
}
