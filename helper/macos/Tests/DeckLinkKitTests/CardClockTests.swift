import Foundation
import StageUtilityOutputCore
import Testing
@testable import DeckLinkKit

/// The card's clock as the scheduler keeps it (`ClockAnchor` in output.hpp, which a
/// DeckLink port and the software clock share): asked of the card once, then kept
/// from the completions, a completion off the clock believed only three in a row,
/// asked again after three frames in a row went out late, and a completion time far
/// from now not used at all. On a clock only the test moves, slot n goes to air at
/// exactly n frame durations, so every slot's air time says where the clock was kept.
@Suite struct CardClockTests {
  static let frameNs = 1001.0 / 60000 * 1e9

  /// How far each new picture's air time is from its slot's true one, ns.
  func airErrors(_ timings: [FrameTiming]) -> [Int64: Double] {
    var errors: [Int64: Double] = [:]
    for t in timings where t.fresh && !t.skipped && t.airNs > 0 {
      errors[t.index] = Double(t.airNs) - Double(t.index) * Self.frameNs
    }
    return errors
  }

  /// The card's answer to where its playback is is half a millisecond off. The first
  /// completion, a millisecond or less from it, sets the clock right, and the card is
  /// not asked again.
  @Test func theClockIsAskedOnceThenKeptFromTheCompletions() {
    let port = softwarePort(NumberedSource())
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeClockReadError(us: 500)
    port.fakeTick(20)
    #expect(port.fakeClockReads() == 1)
    let errors = airErrors(port.timingsForTest())
    #expect(errors.keys.sorted() == Array(2...19))
    #expect(errors.values.allSatisfy { abs($0) < 2 }, "\(errors.sorted { $0.key < $1.key })")
  }

  /// One completion 2 ms off the clock is a frame held on, not the clock moving:
  /// nothing moves. Three in a row are believed, and the slots after them are timed
  /// 2 ms later, until three on time in a row set it back.
  @Test func aCompletionOffTheClockIsBelievedOnlyThreeInARow() {
    let port = softwarePort(NumberedSource())
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(10)
    _ = port.timingsForTest()

    port.fakeCompletionOffset(us: 2000, count: 1)
    port.fakeTick(10)
    let once = airErrors(port.timingsForTest())
    #expect(once.values.allSatisfy { abs($0) < 2 }, "\(once.sorted { $0.key < $1.key })")

    port.fakeCompletionOffset(us: 2000, count: 3)
    port.fakeTick(10)
    let thrice = airErrors(port.timingsForTest())
    let moved = thrice.filter { abs($0.value - 2e6) < 2 }.keys.sorted()
    #expect(moved.count == 3, "\(thrice.sorted { $0.key < $1.key })")
    #expect(thrice.filter { !moved.contains($0.key) }.values.allSatisfy { abs($0) < 2 })
    #expect(port.counters.dropped == 0)
    #expect(port.fakeClockReads() == 1)
  }

  /// Three frames in a row shown late may be the clock as kept being wrong: the card
  /// is asked again. Two, then one on time, is not a run.
  @Test func threeFramesInARowShownLateHaveTheCardAskedAgain() {
    let port = softwarePort(NumberedSource())
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(10)
    #expect(port.fakeClockReads() == 1)
    port.fakeReportLate(2)
    port.fakeTick(5)
    port.fakeReportLate(1)
    port.fakeTick(5)
    #expect(port.fakeClockReads() == 1)
    port.fakeReportLate(3)
    port.fakeTick(5)
    #expect(port.fakeClockReads() == 2)
  }

  /// A completion time 50 ms from now is not when a frame finished. It neither times
  /// the frame nor moves the clock: no slot goes out late for it, the frames are
  /// timed from the card's playback position, and the log says so once.
  @Test func aCompletionTimeFarFromNowIsNotUsed() {
    let log = LogLines()
    let port = softwarePort(NumberedSource(), log: log)
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(10)
    _ = port.timingsForTest()
    port.fakeCompletionOffset(us: 50_000, count: 5)
    port.fakeTick(20)
    let timings = port.timingsForTest()
    #expect(timings.filter { $0.completedNs == 0 }.count == 5)
    #expect(airErrors(timings).values.allSatisfy { abs($0) < 2 })
    #expect(port.counters.dropped == 0)
    port.pollForTest()
    port.pollForTest()
    #expect(
      log.lines.filter { $0.contains("completion times") } == [
        "SDI test: the card said a frame finished 50.0 ms after it reported it; completion times more than 20 ms off are not used, and the slots are timed from its playback position"
      ])
  }
}
