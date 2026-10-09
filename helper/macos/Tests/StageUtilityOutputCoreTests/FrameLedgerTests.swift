import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct FrameLedgerTests {
  /// One step of a run: a picture arriving, or the clock moving `n` slots.
  enum Step {
    case paint
    case tick(Int)
  }

  func run(_ steps: [Step]) -> (FrameLedger, [FrameLedger.Fill]) {
    var ledger = FrameLedger()
    var fills: [FrameLedger.Fill] = []
    for step in steps {
      switch step {
      case .paint: ledger.pictureArrived()
      case .tick(let n): fills.append(ledger.slotsDue(n))
      }
    }
    return (ledger, fills)
  }

  @Test func aPictureBeforeEverySlotIsNewEveryTime() {
    let (l, fills) = run(Array(repeating: [.paint, .tick(1)], count: 4).flatMap { $0 })
    #expect(fills == [.new, .new, .new, .new])
    #expect(l.newFrames == 4 && l.repeated == 0 && l.dropped == 0)
  }

  /// The page missed slot 2: the slot repeats the previous picture, and the late
  /// picture goes out at slot 3 as new. One late paint is one repeat, not a drop.
  @Test func aLatePictureRepeatsTheSlotItMissedAndIsSentAtTheNext() {
    let (l, fills) = run([.paint, .tick(1), .tick(1), .paint, .tick(1)])
    #expect(fills == [.new, .repeated, .new])
    #expect(l.newFrames == 2 && l.repeated == 1 && l.dropped == 0)
  }

  /// Two pictures in one slot: the older was never sent. It is neither a repeat nor
  /// a dropped slot, because every slot went out.
  @Test func twoPicturesInOneSlotSendTheNewerOnce() {
    let (l, fills) = run([.paint, .paint, .tick(1), .tick(1)])
    #expect(fills == [.new, .repeated])
    #expect(l.newFrames == 1 && l.repeated == 1 && l.dropped == 0)
  }

  /// The clock fell three slots behind: two were skipped (dropped) and the one now
  /// due is filled. It resyncs forward, it does not send the skipped ones late.
  @Test func aClockThatFellBehindDropsTheSlotsItSkipped() {
    let (l, fills) = run([.paint, .tick(1), .paint, .tick(3), .tick(1)])
    #expect(fills == [.new, .new, .repeated])
    #expect(l.newFrames == 2 && l.repeated == 1 && l.dropped == 2)
  }

  /// In the server's units (output-health.ts): fps is slots sent per second,
  /// repeated is a PERCENT of the window's slots, dropped is a TOTAL since the
  /// output opened, which the next window does not start over.
  @Test func aSampleIsInTheServersUnits() {
    var l = FrameLedger()
    for i in 0..<80 {
      if i % 10 != 0 { l.pictureArrived() }
      _ = l.slotsDue(1)
    }
    _ = l.slotsDue(3)
    // 81 slots sent in 2 s; 9 of them repeated (the 8 every tenth, and the last).
    #expect(l.takeSample(seconds: 2) == HealthSample(fps: 40.5, repeated: 100 * 9 / 81, dropped: 2))
    l.pictureArrived()
    _ = l.slotsDue(1)
    _ = l.slotsDue(2)
    #expect(l.takeSample(seconds: 1) == HealthSample(fps: 2, repeated: 50, dropped: 3))
    #expect(l.takeSample(seconds: 1) == HealthSample(fps: 0, repeated: 0, dropped: 3))
  }

  /// A new ledger is a reopened output: its total starts from 0, which the server
  /// reads as a fresh baseline.
  @Test func aNewLedgerStartsTheDropTotalOver() {
    var l = FrameLedger()
    _ = l.slotsDue(4)
    #expect(l.takeSample(seconds: 1).dropped == 3)
    var reopened = FrameLedger()
    #expect(reopened.takeSample(seconds: 1).dropped == 0)
  }

  @Test func aNewPictureEndsTheRunOfRepeats() {
    let (l, _) = run([.tick(1), .tick(1), .tick(1)])
    #expect(l.repeatRun == 3)
    let (after, _) = run([.tick(1), .tick(1), .paint, .tick(1)])
    #expect(after.repeatRun == 0)
  }

  /// A stalled page is reloaded once per stall, not on every slot after it.
  @Test func aStallIsReportedOnTheOneSlotThatReachesIt() {
    var l = FrameLedger()
    var stalls = 0
    for _ in 0..<(FrameLedger.stallSlots * 2) {
      _ = l.slotsDue(1)
      if l.justStalled { stalls += 1 }
    }
    #expect(stalls == 1)
  }
}

@Suite struct LagWatchTests {
  @Test func cleanSecondsSayNothing() {
    var w = LagWatch()
    for _ in 0..<10 { #expect(w.second(repeated: 0, dropped: 0) == .none) }
  }

  /// The server's line: 5% of a second's frames repeated is late. Fewer is jitter.
  @Test func aFewRepeatsAreJitterNotFallingBehind() {
    var w = LagWatch()
    for _ in 0..<10 { #expect(w.second(repeated: LagWatch.badRepeats - 1, dropped: 0) == .none) }
    #expect(!w.isBehind)
  }

  @Test func theFirstBadSecondFallsBehindOnce() {
    var w = LagWatch()
    #expect(w.second(repeated: 3, dropped: 0) == .fellBehind(repeated: 3, dropped: 0))
    #expect(w.second(repeated: 9, dropped: 1) == .none)
    var d = LagWatch()
    #expect(d.second(repeated: 0, dropped: 1) == .fellBehind(repeated: 0, dropped: 1))
  }

  @Test func itCatchesUpAfterEnoughGoodSecondsInARow() {
    var w = LagWatch()
    _ = w.second(repeated: 5, dropped: 0)
    for _ in 1..<LagWatch.recoverySeconds { #expect(w.second(repeated: 1, dropped: 0) == .none) }
    #expect(w.second(repeated: 0, dropped: 0) == .caughtUp(afterSeconds: LagWatch.recoverySeconds + 1))
    #expect(!w.isBehind)
  }

  /// A stutter inside the recovery window starts the clean count over, without a
  /// second "fell behind" line.
  @Test func aStutterWhileBehindRestartsTheCleanCount() {
    var w = LagWatch()
    _ = w.second(repeated: 4, dropped: 0)
    for _ in 0..<(LagWatch.recoverySeconds - 1) { _ = w.second(repeated: 0, dropped: 0) }
    #expect(w.second(repeated: 0, dropped: 1) == .none)
    for _ in 0..<(LagWatch.recoverySeconds - 1) { #expect(w.second(repeated: 0, dropped: 0) == .none) }
    #expect(w.second(repeated: 0, dropped: 0) == .caughtUp(afterSeconds: 2 * LagWatch.recoverySeconds + 1))
  }
}
