import Foundation
import Testing
@testable import StageUtilityOutputCore

/// The frame-by-frame cases (a late picture repeats, a stalled host drops the slots
/// it skipped, two pictures in one slot send the newer once) are counted by the
/// shim's scheduler, and tested there: OutputPortTests and UYVYConverterTests.
@Suite struct CardHealthSampleTests {
  /// In the server's units (output-health.ts): fps is slots sent per second,
  /// repeated is a PERCENT of the window's slots, dropped is a TOTAL since the
  /// output opened.
  @Test func aSampleIsInTheServersUnits() {
    #expect(
      HealthSample.card(sent: 81, repeated: 9, droppedSinceOpened: 2, seconds: 2)
        == HealthSample(fps: 40.5, repeated: 100 * 9 / 81, dropped: 2))
    #expect(
      HealthSample.card(sent: 2, repeated: 1, droppedSinceOpened: 3, seconds: 1)
        == HealthSample(fps: 2, repeated: 50, dropped: 3))
  }

  /// A window with nothing sent is 0 fps and 0% repeated, not a division by zero,
  /// and still carries the total.
  @Test func anEmptyWindowKeepsTheTotal() {
    #expect(
      HealthSample.card(sent: 0, repeated: 0, droppedSinceOpened: 3, seconds: 1)
        == HealthSample(fps: 0, repeated: 0, dropped: 3))
    #expect(HealthSample.card(sent: 5, repeated: 0, droppedSinceOpened: 0, seconds: 0).fps == 0)
  }
}

@Suite struct CardWatchTests {
  /// Before the page has drawn, every frame repeats because there is nothing to
  /// send yet: not falling behind, and not a stalled page.
  @Test func nothingIsJudgedBeforeThePageFirstDraws() {
    var w = CardWatch()
    for _ in 0..<(CardWatch.stallSeconds * 2) { #expect(w.second(sent: 60, repeated: 60, dropped: 0) == []) }
    #expect(!w.drawing)
    // The second it first draws in is mostly the wait for it.
    #expect(w.second(sent: 60, repeated: 50, dropped: 0) == [])
    #expect(w.drawing)
    #expect(w.second(sent: 60, repeated: 3, dropped: 0) == [.fellBehind(repeated: 3, dropped: 0)])
  }

  @Test func aDroppedSlotFallsBehindAndCleanSecondsCatchUp() {
    var w = CardWatch()
    _ = w.second(sent: 60, repeated: 0, dropped: 0)
    #expect(w.second(sent: 60, repeated: 0, dropped: 1) == [.fellBehind(repeated: 0, dropped: 1)])
    for _ in 1..<LagWatch.recoverySeconds { #expect(w.second(sent: 60, repeated: 0, dropped: 0) == []) }
    #expect(w.second(sent: 60, repeated: 0, dropped: 0) == [.caughtUp(afterSeconds: LagWatch.recoverySeconds + 1)])
  }

  /// A stalled page is reloaded once per stall, not every second after it.
  @Test func aStallIsReportedOnTheOneSecondThatReachesIt() {
    var w = CardWatch()
    _ = w.second(sent: 60, repeated: 0, dropped: 0)
    var stalls: [CardWatch.Event] = []
    for _ in 0..<(CardWatch.stallSeconds * 3) {
      stalls += w.second(sent: 60, repeated: 60, dropped: 0).filter { if case .stalled = $0 { return true } else { return false } }
    }
    #expect(stalls == [.stalled(seconds: CardWatch.stallSeconds)])
  }

  /// One new picture ends the run, so a page that draws now and then is never
  /// reloaded for it.
  @Test func aNewPictureEndsTheRunOfSilentSeconds() {
    var w = CardWatch()
    _ = w.second(sent: 60, repeated: 0, dropped: 0)
    var events: [CardWatch.Event] = []
    for n in 0..<(CardWatch.stallSeconds * 4) {
      let fresh = n % (CardWatch.stallSeconds - 1) == 0 ? 1 : 0
      events += w.second(sent: 60, repeated: 60 - fresh, dropped: 0)
    }
    #expect(!events.contains(.stalled(seconds: CardWatch.stallSeconds)))
  }

  /// A second in which the clock sent nothing (a port closed or lost) says nothing
  /// about the page.
  @Test func aSecondWithNothingSentIsNotSilence() {
    var w = CardWatch()
    _ = w.second(sent: 60, repeated: 0, dropped: 0)
    for _ in 0..<(CardWatch.stallSeconds * 2) { #expect(w.second(sent: 0, repeated: 0, dropped: 0) == []) }
  }
}

@Suite struct LagWatchTests {
  @Test func cleanSecondsSayNothing() {
    var w = LagWatch()
    for _ in 0..<10 { #expect(w.second(sent: 60, repeated: 0, dropped: 0) == .none) }
  }

  /// The server's line, `repeated >= 5` percent (output-health.ts), at the rates a
  /// screen may be set to: the fewest repeats in a second that are late at each.
  /// Fewer is jitter. A count fixed at 3 for 59.94 let 2 in 24 frames (8%) through at
  /// 23.98, where the server called the same window struggling.
  @Test func lateIsTheServersFivePercentAtEveryRate() {
    let fewestLate = [24: 2, 25: 2, 30: 2, 50: 3, 60: 3]
    for (fps, repeats) in fewestLate.sorted(by: { $0.key < $1.key }) {
      #expect(LagWatch.late(repeated: repeats, of: fps), "\(repeats) of \(fps)")
      #expect(!LagWatch.late(repeated: repeats - 1, of: fps), "\(repeats - 1) of \(fps)")
      var w = LagWatch()
      #expect(w.second(sent: fps, repeated: repeats - 1, dropped: 0) == .none)
      #expect(w.second(sent: fps, repeated: repeats, dropped: 0) == .fellBehind(repeated: repeats, dropped: 0))
    }
    #expect(!LagWatch.late(repeated: 0, of: 0))
  }

  @Test func theFirstBadSecondFallsBehindOnce() {
    var w = LagWatch()
    #expect(w.second(sent: 60, repeated: 3, dropped: 0) == .fellBehind(repeated: 3, dropped: 0))
    #expect(w.second(sent: 60, repeated: 9, dropped: 1) == .none)
    var d = LagWatch()
    #expect(d.second(sent: 60, repeated: 0, dropped: 1) == .fellBehind(repeated: 0, dropped: 1))
  }

  @Test func itCatchesUpAfterEnoughGoodSecondsInARow() {
    var w = LagWatch()
    _ = w.second(sent: 60, repeated: 5, dropped: 0)
    for _ in 1..<LagWatch.recoverySeconds { #expect(w.second(sent: 60, repeated: 1, dropped: 0) == .none) }
    #expect(w.second(sent: 60, repeated: 0, dropped: 0) == .caughtUp(afterSeconds: LagWatch.recoverySeconds + 1))
    #expect(!w.isBehind)
  }

  /// A stutter inside the recovery window starts the clean count over, without a
  /// second "fell behind" line.
  @Test func aStutterWhileBehindRestartsTheCleanCount() {
    var w = LagWatch()
    _ = w.second(sent: 60, repeated: 4, dropped: 0)
    for _ in 0..<(LagWatch.recoverySeconds - 1) { _ = w.second(sent: 60, repeated: 0, dropped: 0) }
    #expect(w.second(sent: 60, repeated: 0, dropped: 1) == .none)
    for _ in 0..<(LagWatch.recoverySeconds - 1) { #expect(w.second(sent: 60, repeated: 0, dropped: 0) == .none) }
    #expect(w.second(sent: 60, repeated: 0, dropped: 0) == .caughtUp(afterSeconds: 2 * LagWatch.recoverySeconds + 1))
  }
}
