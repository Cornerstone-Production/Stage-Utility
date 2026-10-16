import Foundation
import StageUtilityOutputCore

/// Which frame a card wants, on its own clock.
public struct CardFrameRequest: Equatable, Sendable {
  /// Frames since playback started. A schedule that fell behind the card jumps
  /// forward, so this can skip.
  public var index: Int64
  /// When the frame is shown, in `timeScale` units since playback started.
  public var streamTime: Int64
  public var timeScale: Int64

  public var seconds: Double { Double(streamTime) / Double(timeScale) }
}

/// The memory a picture goes into: 8-bit UYVY, `rowBytes` per line, `length` long:
/// a frame the card made, or one of the helper's own.
public struct CardFrameTarget {
  public var bytes: UnsafeMutableRawPointer
  public var length: Int
  public var rowBytes: Int
  public var width: Int
  public var height: Int
  /// Which of the output's frames this is. The same slot is the same memory for as
  /// long as the output is open.
  public var slot: Int

  public init(bytes: UnsafeMutableRawPointer, length: Int, rowBytes: Int, width: Int, height: Int, slot: Int) {
    self.bytes = bytes
    self.length = length
    self.rowBytes = rowBytes
    self.width = width
    self.height = height
    self.slot = slot
  }
}

/// When a picture was made, on the host clock (`DispatchTime.uptimeNanoseconds`,
/// mach_absolute_time), 0 where unknown: what a frame's timing is measured from.
public struct CardPicture: Equatable, Sendable {
  /// When the page drew the picture's content: the begin frame it rendered for.
  public var contentNs: UInt64
  /// When the page handed the picture over.
  public var paintNs: UInt64
  /// When it was converted and ready to go into a frame.
  public var readyNs: UInt64
  /// When the page's own copy could be let go: the paint callback returned.
  public var returnedNs: UInt64

  public init(contentNs: UInt64 = 0, paintNs: UInt64 = 0, readyNs: UInt64 = 0, returnedNs: UInt64 = 0) {
    self.contentNs = contentNs
    self.paintNs = paintNs
    self.readyNs = readyNs
    self.returnedNs = returnedNs
  }

  /// A picture whose times nobody kept.
  public static let untimed = CardPicture()
}

/// What feeds a card: told when to start each frame's picture, and asked for it
/// later, both on the card's clock.
///
/// The name is the card side's half of a pair: a `CardSink` pulls, a
/// `CardFrameSource` answers. A windowless browser that renders on command (a begin
/// frame per card frame) is the source this is shaped for.
public protocol CardFrameSource: AnyObject {
  /// Start on the picture for `request`: called the head start before the frame
  /// goes to air. Return at once.
  func begin(_ request: CardFrameRequest)

  /// Write the newest picture into `target` and return its times; or return nil,
  /// having written nothing, when there is no new picture, and the previous one
  /// goes out again as a repeat.
  ///
  /// Called on the output's clock thread the fill lead before the frame goes to
  /// air, while the card waits (the pre-roll's two on the thread opening the
  /// output): a copy, not a render. No locks held elsewhere for long, no
  /// main-thread hops.
  func fill(_ request: CardFrameRequest, into target: CardFrameTarget) -> CardPicture?
}

extension CardFrameSource {
  /// A source that draws when it likes has nothing to start.
  public func begin(_ request: CardFrameRequest) {}
}

/// An output's frame counts since it was made, across reopenings: the one count
/// of what a card output sent, real port or software clock.
public struct CardCounters: Equatable {
  /// Frames handed to the card.
  public var scheduled: UInt64 = 0
  /// Of those, frames that carried the previous picture again.
  public var repeated: UInt64 = 0
  /// Frames the card reported late or dropped.
  public var dropped: UInt64 = 0
  /// Times the output found itself too late to fill a slot on time and skipped
  /// ahead: a run of skipped slots is one.
  public var resyncs: UInt64 = 0
  /// Slots skipped, which went out with no frame of ours: the card held its last
  /// picture.
  public var skipped: UInt64 = 0

  /// New pictures sent: every frame scheduled that was not a repeat.
  public var rendered: UInt64 { scheduled - repeated }

  /// What the server's health route calls dropped: every slot that did not go out
  /// as scheduled, whether the card said so (`dropped`) or the schedule passed it
  /// over (`skipped`).
  public var missed: UInt64 { dropped + skipped }

  public init(scheduled: UInt64 = 0, repeated: UInt64 = 0, dropped: UInt64 = 0, resyncs: UInt64 = 0, skipped: UInt64 = 0) {
    self.scheduled = scheduled
    self.repeated = repeated
    self.dropped = dropped
    self.resyncs = resyncs
    self.skipped = skipped
  }

  static func + (a: CardCounters, b: CardCounters) -> CardCounters {
    CardCounters(
      scheduled: a.scheduled + b.scheduled, repeated: a.repeated + b.repeated, dropped: a.dropped + b.dropped,
      resyncs: a.resyncs + b.resyncs, skipped: a.skipped + b.skipped)
  }
}

/// An output that pulls pictures from a `CardFrameSource` on its own clock and
/// counts what happened: a DeckLink port, or the software clock standing in for
/// one.
public protocol CardSink: AnyObject {
  var counters: CardCounters { get }
  /// The window since the last call, in the server's units: `fps` is frames sent
  /// per second, repeats included; `repeated` a percent of them; `dropped` the
  /// total since the output was made (`CardCounters.missed`).
  func takeHealthSample() -> HealthSample
  func close()
}
