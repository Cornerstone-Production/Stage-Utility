import Foundation
import StageUtilityOutputCore

/// Which frame a card wants, on its own clock.
public struct CardFrameRequest: Equatable {
  /// Frames since playback started. A schedule that fell behind the card jumps
  /// forward, so this can skip.
  public var index: Int64
  /// When the frame is shown, in `timeScale` units since playback started.
  public var streamTime: Int64
  public var timeScale: Int64

  public var seconds: Double { Double(streamTime) / Double(timeScale) }
}

/// The memory a picture goes into: 8-bit UYVY, `rowBytes` per line. Page-aligned
/// and a whole number of pages long, so Metal can write into it without a copy.
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

/// What feeds a card: asked for each frame on the card's clock.
///
/// The name is the card side's half of a pair: a `CardSink` pulls, a
/// `CardFrameSource` answers. A windowless browser that renders on command (a begin
/// frame per card frame) is the source this is shaped for.
public protocol CardFrameSource: AnyObject {
  /// Write the picture for `request` into `target` and return true; or return
  /// false, having written nothing, when there is no new picture, and the previous
  /// one goes out again as a repeat.
  ///
  /// Called on the card's thread while the card waits: no locks held elsewhere for
  /// long, no main-thread hops, back within a frame.
  func fill(_ request: CardFrameRequest, into target: CardFrameTarget) -> Bool
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
  /// Times the schedule fell behind the card and was moved forward.
  public var resyncs: UInt64 = 0
  /// Slots those moves passed over, which went out with no frame of ours: the card
  /// held its last picture.
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
