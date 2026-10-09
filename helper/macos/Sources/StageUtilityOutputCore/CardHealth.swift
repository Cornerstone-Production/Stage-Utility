import Foundation

// A card output's frames are counted once, by the scheduler in the DeckLink shim
// (`CardCounters` in DeckLinkKit), for a real port and for the software clock
// alike. What is here turns those counts into what the server is told and what
// the log says.

extension HealthSample {
  /// A card output's window in the server's units (`parseHealthReport` in
  /// output-health.ts): `fps` is frames sent per second, repeats included, which
  /// only missed slots lower; `repeated` is the PERCENT of those frames that
  /// carried the previous picture again; `dropped` is every slot missed since the
  /// output was made, a running total the next window does not start over.
  public static func card(sent: UInt64, repeated: UInt64, droppedSinceOpened: UInt64, seconds: TimeInterval)
    -> HealthSample
  {
    HealthSample(
      fps: seconds > 0 ? Double(sent) / seconds : 0,
      repeated: sent > 0 ? 100 * Double(repeated) / Double(sent) : 0,
      dropped: Int(droppedSinceOpened))
  }
}

/// Whether a card output is keeping up, decided once a second from that second's
/// repeats and drops, and worth a log line only when it changes.
///
/// A second is bad when it dropped any slot, or repeated `badRepeatPercent` (5%) or
/// more of the frames it sent: the server's own line between late and merely
/// jittery (`REPEATED_BAD_PERCENT` in output-health.ts, "one frame in twenty is
/// plain to the eye"), so the log and the server agree at every rate, 3 repeats a
/// second at 59.94 and 2 at 23.98. A single repeat when the main thread was busy for
/// a moment is not falling behind. It falls behind on the first bad second, and is
/// back once `recoverySeconds` seconds in a row have been good, so a page that
/// stutters now and then is one pair of lines, not a line a second.
public struct LagWatch: Equatable {
  public enum Event: Equatable {
    case none
    /// Repeats or drops started, with the counts of the second that started them.
    case fellBehind(repeated: Int, dropped: Int)
    /// Clean again, after being behind for this many seconds (the clean ones included).
    case caughtUp(afterSeconds: Int)
  }

  public static let recoverySeconds = 5
  /// `REPEATED_BAD_PERCENT` in the server's output-health.ts.
  public static let badRepeatPercent = 5.0

  public private(set) var isBehind = false
  private var cleanRun = 0
  private var behindFor = 0

  public init() {}

  /// Whether `repeated` of `sent` frames is the server's "late".
  public static func late(repeated: Int, of sent: Int) -> Bool {
    sent > 0 && 100 * Double(repeated) >= badRepeatPercent * Double(sent)
  }

  public mutating func second(sent: Int, repeated: Int, dropped: Int) -> Event {
    let clean = !LagWatch.late(repeated: repeated, of: sent) && dropped == 0
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

/// Everything a card output's counts say once a second: falling behind and
/// catching up (`LagWatch`), a page that has stopped drawing, and one that never has.
///
/// Falling behind is not judged until the page has drawn its first picture. Before
/// it the browser is still being made, and every frame repeats by necessity.
///
/// Every request for a frame paints, even when nothing on the page changed (see
/// `begin_frame` in stage_cef_host.h), so a second with no new picture at all means
/// the page has stopped, not that it is idle. After `stallSeconds` of those in a
/// row it is reported stalled, once, and the owner reloads the page. A page that has
/// never handed over a picture `noPictureSeconds` after the output started sending
/// is reported too: the card is sending its black pre-roll, and the frame rate
/// alone would read as healthy. Either way `silence` says so until a picture comes.
public struct CardWatch: Equatable {
  public enum Event: Equatable {
    case fellBehind(repeated: Int, dropped: Int)
    case caughtUp(afterSeconds: Int)
    /// No new picture for this many seconds, after the page had drawn.
    case stalled(seconds: Int)
    /// Sending for this many seconds, and the page has never drawn.
    case noPicture(seconds: Int)
    /// A new picture, after one of the two above.
    case drawingAgain
  }

  /// Why an output that is sending frames is not sending the page.
  public enum Silence: Equatable, Sendable {
    /// The page has never handed over a picture: the card sends black.
    case neverDrawn
    /// The page has handed over nothing new for `stallSeconds`: the card holds its
    /// last picture.
    case stopped
  }

  /// 300 frames at 59.94.
  public static let stallSeconds = 5
  /// Long enough for a browser to be made and its first page to paint, which takes
  /// a second or two; a card output's begin frames paint even a blank page.
  public static let noPictureSeconds = 10

  public private(set) var drawing = false
  /// Why the output is not sending the page, while it is not; nil while it is.
  public private(set) var silence: Silence?
  private var lag = LagWatch()
  private var silentRun = 0
  private var undrawnRun = 0

  public init() {}

  public var isBehind: Bool { lag.isBehind }

  /// One second's frames: `sent` scheduled, `repeated` of them carrying the
  /// previous picture, `dropped` slots missed.
  public mutating func second(sent: Int, repeated: Int, dropped: Int) -> [Event] {
    let fresh = sent - repeated
    var events: [Event] = []
    if fresh > 0, silence != nil {
      silence = nil
      events.append(.drawingAgain)
    }
    guard drawing else {
      drawing = fresh > 0
      if !drawing, sent > 0 {
        undrawnRun += 1
        if undrawnRun == CardWatch.noPictureSeconds {
          silence = .neverDrawn
          events.append(.noPicture(seconds: undrawnRun))
        }
      }
      return events
    }
    switch lag.second(sent: sent, repeated: repeated, dropped: dropped) {
    case .none: break
    case .fellBehind(let r, let d): events.append(.fellBehind(repeated: r, dropped: d))
    case .caughtUp(let s): events.append(.caughtUp(afterSeconds: s))
    }
    if fresh > 0 {
      silentRun = 0
    } else if sent > 0 {
      silentRun += 1
      if silentRun == CardWatch.stallSeconds {
        silence = .stopped
        events.append(.stalled(seconds: silentRun))
      }
    }
    return events
  }
}
