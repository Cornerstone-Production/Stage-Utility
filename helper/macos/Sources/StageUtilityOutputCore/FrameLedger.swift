import Foundation

/// What a card output did with its frame slots, counted the way its health post
/// reports them.
///
/// A card output sends a frame every slot of its clock (59.94 a second), whatever
/// the page does. At each slot it sends the newest picture the page has drawn since
/// the last slot; if none has come, it sends the previous picture again; and if the
/// clock itself fell behind, the slots it passed over were never sent at all. The
/// clock is the card's own in a DeckLink output and a software timer in the null
/// sink; both count here, so the numbers mean the same thing for both.
///
/// - **new**: a slot sent with a picture not sent before.
/// - **repeated**: a slot sent with the previous picture, because no new one came in
///   time. The page, its renderer or the GPU was late.
/// - **dropped**: a slot not sent at all, because the schedule fell behind its clock
///   and skipped ahead rather than build delay.
///
/// The health post reports repeats as a percent of the window's slots and drops as
/// a total since the output opened (one ledger per opening), which is what the
/// server's health route takes.
///
/// Every request for a frame paints, even when nothing on the page changed (see
/// `begin_frame` in stage_cef_host.h), so a repeat always means late, never idle.
public struct FrameLedger: Equatable {
  public enum Fill: Equatable {
    case new
    case repeated
  }

  /// Since the last `takeSample`.
  public private(set) var newFrames = 0
  public private(set) var repeated = 0
  public private(set) var dropped = 0
  /// Since the output opened.
  public private(set) var droppedTotal = 0
  /// Slots repeated in a row, up to now: how long the page has drawn nothing.
  public private(set) var repeatRun = 0
  private var pictureWaiting = false

  public init() {}

  /// The page drew a picture.
  public mutating func pictureArrived() { pictureWaiting = true }

  /// The clock reached the next slot. `elapsed` is how many slots it has moved
  /// since the last call: 1 on time, more when it fell behind, in which case all
  /// but the last were skipped. Says what the slot now due is sent with.
  public mutating func slotsDue(_ elapsed: Int) -> Fill {
    if elapsed > 1 {
      dropped += elapsed - 1
      droppedTotal += elapsed - 1
    }
    if pictureWaiting {
      pictureWaiting = false
      newFrames += 1
      repeatRun = 0
      return .new
    }
    repeated += 1
    repeatRun += 1
    return .repeated
  }

  /// The window since the last sample, and a fresh start for the next. `fps` is
  /// slots sent per second, new and repeated alike: the rate the output actually
  /// ran at, which only dropped slots lower. `repeated` is the percent of those
  /// slots that repeated; `dropped` is every slot dropped since the output opened.
  public mutating func takeSample(seconds: TimeInterval) -> HealthSample {
    let sent = newFrames + repeated
    let sample = HealthSample(
      fps: seconds > 0 ? Double(sent) / seconds : 0,
      repeated: sent > 0 ? 100 * Double(repeated) / Double(sent) : 0,
      dropped: droppedTotal)
    newFrames = 0
    repeated = 0
    dropped = 0
    return sample
  }

  /// Slots with no new picture after which the page is taken to have stopped
  /// drawing (5 s at 59.94), and is reloaded.
  public static let stallSlots = 300

  /// True on exactly the slot that makes the run of repeats reach `stallSlots`:
  /// once per stall, not on every repeat after it.
  public var justStalled: Bool { repeatRun == FrameLedger.stallSlots }
}

/// Whether a card output is keeping up, decided once a second from that second's
/// repeats and drops, and worth a log line only when it changes.
///
/// A second is bad when it dropped any slot, or repeated `badRepeats` or more: 5% of
/// 59.94, the server's own line between late and merely jittery
/// (`REPEATED_BAD_PERCENT` in output-health.ts, "one frame in twenty is plain to the
/// eye"). A single repeat when the main thread was busy for a moment is not falling
/// behind. It falls behind on the first bad second, and is back once
/// `recoverySeconds` seconds in a row have been good, so a page that stutters now
/// and then is one pair of lines, not a line a second.
public struct LagWatch: Equatable {
  public enum Event: Equatable {
    case none
    /// Repeats or drops started, with the counts of the second that started them.
    case fellBehind(repeated: Int, dropped: Int)
    /// Clean again, after being behind for this many seconds (the clean ones included).
    case caughtUp(afterSeconds: Int)
  }

  public static let recoverySeconds = 5
  public static let badRepeats = 3

  public private(set) var isBehind = false
  private var cleanRun = 0
  private var behindFor = 0

  public init() {}

  public mutating func second(repeated: Int, dropped: Int) -> Event {
    let clean = repeated < LagWatch.badRepeats && dropped == 0
    if !isBehind {
      if clean { return .none }
      isBehind = true
      behindFor = 1
      cleanRun = 0
      return .fellBehind(repeated: repeated, dropped: dropped)
    }
    behindFor += 1
    cleanRun = clean ? cleanRun + 1 : 0
    guard cleanRun >= LagWatch.recoverySeconds else { return .none }
    isBehind = false
    cleanRun = 0
    return .caughtUp(afterSeconds: behindFor)
  }
}
