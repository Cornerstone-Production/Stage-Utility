import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct HealthOutcomeTests {
  /// What the server's health route means: 404 no device with that id, 401 a wrong
  /// or missing secret, 400 a body that is not a report.
  @Test func mapsTheRoutesStatuses() {
    #expect(HealthOutcome.from(status: 200) == .accepted)
    #expect(HealthOutcome.from(status: 204) == .accepted)
    #expect(HealthOutcome.from(status: 404) == .unknownDevice)
    #expect(HealthOutcome.from(status: 401) == .unauthorised)
    #expect(HealthOutcome.from(status: 400) == .rejected(400))
    #expect(HealthOutcome.from(status: 500) == .rejected(500))
    #expect(HealthOutcome.from(status: 302) == .rejected(302))
  }
}

@Suite struct HealthGateTests {
  let t0 = Date(timeIntervalSince1970: 1_760_000_000)
  func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

  @Test func aNewGateIsDue() {
    #expect(HealthGate().isDue(at: t0))
  }

  /// A released output answers 404. It must stop asking, and ask again later.
  @Test func aFourOhFourPausesAndThenWaitsOut() {
    var g = HealthGate()
    #expect(g.record(.unknownDevice, at: t0) == .paused(.unknownDevice, retryIn: 30))
    #expect(g.pause == .unknownDevice)
    #expect(!g.isDue(at: at(10)))
    #expect(!g.isDue(at: at(29.9)))
    #expect(g.isDue(at: at(30)))
  }

  @Test func theWaitGrowsToFiveMinutesAndSaysNothingMore() {
    var g = HealthGate()
    var waits: [TimeInterval] = []
    var now = t0
    for _ in 0..<6 {
      _ = g.record(.unknownDevice, at: now)
      // The pause ends exactly this long after the post.
      var step: TimeInterval = 0
      while !g.isDue(at: now.addingTimeInterval(step)) { step += 1 }
      waits.append(step)
      now = now.addingTimeInterval(step)
    }
    #expect(waits == [30, 60, 120, 300, 300, 300])
  }

  @Test func onlyTheFirstPauseOfARunIsWorthALine() {
    var g = HealthGate()
    _ = g.record(.unknownDevice, at: t0)
    #expect(g.record(.unknownDevice, at: at(30)) == .none)
    #expect(g.record(.unknownDevice, at: at(100)) == .none)
  }

  @Test func theSetUpScreenComingBackResumesAtOnce() {
    var g = HealthGate()
    _ = g.record(.unknownDevice, at: t0)
    #expect(!g.isDue(at: at(5)))
    g.boundAgain()
    #expect(g.isDue(at: at(5)))
    #expect(g.pause == nil)
    // And the wait starts from the beginning again.
    #expect(g.record(.unknownDevice, at: at(5)) == .paused(.unknownDevice, retryIn: 30))
  }

  @Test func anAcceptedPostEndsThePauseAndSaysSo() {
    var g = HealthGate()
    _ = g.record(.unknownDevice, at: t0)
    #expect(g.record(.accepted, at: at(30)) == .recovered)
    #expect(g.pause == nil)
    #expect(g.isDue(at: at(30)))
    #expect(g.record(.accepted, at: at(40)) == .none)
  }

  @Test func aRefusedTokenPausesToo() {
    var g = HealthGate()
    #expect(g.record(.unauthorised, at: t0) == .paused(.unauthorised, retryIn: 30))
    #expect(!g.isDue(at: at(10)))
  }

  @Test func aRejectedBodyKeepsPostingAndSaysItOnce() {
    var g = HealthGate()
    #expect(g.record(.rejected(400), at: t0) == .failing("the server refused a health post (HTTP 400)"))
    #expect(g.record(.rejected(400), at: at(10)) == .none)
    #expect(g.isDue(at: at(10)))
    #expect(g.record(.accepted, at: at(20)) == .recovered)
  }

  @Test func silenceIsSaidOnceAndTheThirdMissSendsDiscoveryLooking() {
    var g = HealthGate()
    #expect(g.record(.unreachable("timed out"), at: t0) == .failing("health post failed: timed out"))
    #expect(g.record(.unreachable("timed out"), at: at(10)) == .none)
    #expect(g.record(.unreachable("timed out"), at: at(20)) == .rediscover(misses: 3))
    // Only the third: not every miss after it.
    #expect(g.record(.unreachable("timed out"), at: at(30)) == .none)
    #expect(g.isDue(at: at(30)))
  }

  @Test func anAnswerResetsTheMissCount() {
    var g = HealthGate()
    _ = g.record(.unreachable("x"), at: t0)
    _ = g.record(.unreachable("x"), at: at(10))
    _ = g.record(.accepted, at: at(20))
    _ = g.record(.unreachable("x"), at: at(30))
    _ = g.record(.unreachable("x"), at: at(40))
    #expect(g.record(.unreachable("x"), at: at(50)) == .rediscover(misses: 3))
  }
}

@Suite struct HealthBoardTests {
  let now = Date(timeIntervalSince1970: 1_760_000_000)

  /// The reported bug: one output's 404 turned posting off for every output.
  @Test func oneOutputsFourOhFourDoesNotPauseAnother() {
    var board = HealthBoard()
    _ = board.record(.unknownDevice, for: "released", at: now)
    #expect(!board.isDue("released", at: now.addingTimeInterval(5)))
    #expect(board.isDue("other", at: now.addingTimeInterval(5)))
    #expect(board.pause(for: "released") == .unknownDevice)
    #expect(board.pause(for: "other") == nil)
    // The other keeps posting, and keeps being accepted.
    #expect(board.record(.accepted, for: "other", at: now) == .none)
    #expect(board.pause(for: "released") == .unknownDevice)
  }

  @Test func anOutputThatWasTurnedOffStartsClean() {
    var board = HealthBoard()
    _ = board.record(.unknownDevice, for: "k", at: now)
    board.forget("k")
    #expect(board.isDue("k", at: now))
    #expect(board.pause(for: "k") == nil)
  }
}

@Suite struct HealthPauseStatusTests {
  typealias I = StatusText.Input

  @Test func aPausedOutputSaysWhyOnItsOwnLine() {
    #expect(StatusText.outputLine(I(
      enabled: true, isMain: false, serverKnown: true, boundScreenName: "Left", showingBound: true, fps: 59.94,
      healthPause: .unknownDevice)) == "Left · not set up on the server, health paused")
    #expect(StatusText.outputLine(I(
      enabled: true, isMain: false, serverKnown: true, showingBound: true, healthPause: .unauthorised))
      == "Showing a screen · token refused, health paused")
  }

  /// A page that is not up is the bigger news, and an output on the holding screen
  /// has nothing to report health about.
  @Test func theOtherStatesWinOverAPause() {
    #expect(StatusText.outputLine(I(
      enabled: true, isMain: false, serverKnown: true, unreachable: true, showingBound: true, healthPause: .unknownDevice))
      == "Cannot reach the server. Retrying")
    #expect(StatusText.outputLine(I(enabled: true, isMain: false, serverKnown: true, healthPause: .unknownDevice))
      == "Waiting to be set up on the server")
  }
}
