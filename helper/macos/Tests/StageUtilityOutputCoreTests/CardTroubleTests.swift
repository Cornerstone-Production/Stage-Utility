import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct CardTroubleTests {
  @Test func theFirstReadingIsTheBaseline() {
    var t = CardTrouble()
    #expect(t.observe(repeated: 40, dropped: 7) == [])
    #expect(t.observe(repeated: 40, dropped: 7) == [])
  }

  @Test func troubleIsReportedWhenItStartsAndWhenItHasStopped() {
    var t = CardTrouble(quietPolls: 3)
    _ = t.observe(repeated: 0, dropped: 0)
    #expect(t.observe(repeated: 2, dropped: 0) == [.started(.repeats, count: 2)])
    #expect(t.observe(repeated: 5, dropped: 0) == [])
    #expect(t.observe(repeated: 5, dropped: 0) == [])
    #expect(t.observe(repeated: 5, dropped: 0) == [])
    #expect(t.observe(repeated: 5, dropped: 0) == [.stopped(.repeats, total: 5)])
    #expect(t.observe(repeated: 5, dropped: 0) == [])
  }

  /// Trouble every other poll is one episode. Without the run of quiet polls it
  /// would be a started and a stopped line every two seconds for as long as it
  /// went on.
  @Test func troubleOnAndOffIsOneEpisode() {
    var t = CardTrouble(quietPolls: 3)
    _ = t.observe(repeated: 0, dropped: 0)
    var events: [CardTrouble.Event] = []
    var count: UInt64 = 0
    for poll in 0..<20 {
      if poll % 2 == 0 { count += 1 }
      events += t.observe(repeated: count, dropped: 0)
    }
    #expect(events == [.started(.repeats, count: 1)])
  }

  @Test func repeatsAndDropsAreTrackedApart() {
    var t = CardTrouble(quietPolls: 1)
    _ = t.observe(repeated: 0, dropped: 0)
    #expect(t.observe(repeated: 1, dropped: 4) == [.started(.repeats, count: 1), .started(.drops, count: 4)])
    #expect(t.observe(repeated: 1, dropped: 6) == [.stopped(.repeats, total: 1)])
    #expect(t.observe(repeated: 1, dropped: 6) == [.stopped(.drops, total: 6)])
  }

  @Test func countsThatGoBackwardsStartAfresh() {
    var t = CardTrouble()
    _ = t.observe(repeated: 100, dropped: 0)
    #expect(t.observe(repeated: 3, dropped: 0) == [])
    #expect(t.observe(repeated: 4, dropped: 0) == [.started(.repeats, count: 1)])
  }

  /// A port reopened mid-episode starts from new counts but the episode goes on,
  /// so its "stopped" line still comes.
  @Test func aRebaseKeepsTheEpisode() {
    var t = CardTrouble(quietPolls: 2)
    _ = t.observe(repeated: 0, dropped: 0)
    #expect(t.observe(repeated: 3, dropped: 0) == [.started(.repeats, count: 3)])
    t.rebase(repeated: 6, dropped: 0)
    #expect(t.observe(repeated: 6, dropped: 0) == [])
    #expect(t.observe(repeated: 6, dropped: 0) == [.stopped(.repeats, total: 3)])
  }
}
