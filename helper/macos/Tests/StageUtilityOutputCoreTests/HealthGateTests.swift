import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct HealthOutcomeTests {
  /// 401 and 404 are one answer to a device the server does not recognise: the
  /// server says 401 for an unknown id and for a wrong token alike, so ids cannot
  /// be enumerated, and an older one said 404.
  @Test func mapsTheRoutesStatuses() {
    #expect(HealthOutcome.from(status: 200) == .accepted)
    #expect(HealthOutcome.from(status: 204) == .accepted)
    #expect(HealthOutcome.from(status: 404) == .notRecognised(status: 404))
    #expect(HealthOutcome.from(status: 401) == .notRecognised(status: 401))
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
    #expect(g.record(.notRecognised(status: 404), at: t0) == .paused(status: 404, retryIn: 30))
    #expect(g.isPaused)
    #expect(!g.isDue(at: at(10)))
    #expect(!g.isDue(at: at(29.9)))
    #expect(g.isDue(at: at(30)))
  }

  @Test func theWaitGrowsToFiveMinutesAndSaysNothingMore() {
    var g = HealthGate()
    var waits: [TimeInterval] = []
    var now = t0
    for _ in 0..<6 {
      _ = g.record(.notRecognised(status: 404), at: now)
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
    _ = g.record(.notRecognised(status: 404), at: t0)
    #expect(g.record(.notRecognised(status: 404), at: at(30)) == .none)
    #expect(g.record(.notRecognised(status: 404), at: at(100)) == .none)
  }

  @Test func theSetUpScreenComingBackResumesAtOnce() {
    var g = HealthGate()
    _ = g.record(.notRecognised(status: 404), at: t0)
    #expect(!g.isDue(at: at(5)))
    g.boundAgain()
    #expect(g.isDue(at: at(5)))
    #expect(!g.isPaused)
    // And the wait starts from the beginning again.
    #expect(g.record(.notRecognised(status: 404), at: at(5)) == .paused(status: 404, retryIn: 30))
  }

  @Test func anAcceptedPostEndsThePauseAndSaysSo() {
    var g = HealthGate()
    _ = g.record(.notRecognised(status: 404), at: t0)
    #expect(g.record(.accepted, at: at(30)) == .recovered)
    #expect(!g.isPaused)
    #expect(g.isDue(at: at(30)))
    #expect(g.record(.accepted, at: at(40)) == .none)
  }

  /// The server answers 401 for an unknown id AND a wrong token: both pause.
  @Test func aFourOhOneIsTheSameAsAFourOhFour() {
    var g = HealthGate()
    #expect(g.record(.notRecognised(status: 401), at: t0) == .paused(status: 401, retryIn: 30))
    #expect(!g.isDue(at: at(10)))
    #expect(g.isPaused)
    // A 401 after a 404 is the same run, so not another line.
    #expect(g.record(.notRecognised(status: 404), at: at(30)) == .none)
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
    _ = board.record(.notRecognised(status: 404), for: "released", at: now)
    #expect(!board.isDue("released", at: now.addingTimeInterval(5)))
    #expect(board.isDue("other", at: now.addingTimeInterval(5)))
    #expect(board.isPaused("released"))
    #expect(!board.isPaused("other"))
    // The other keeps posting, and keeps being accepted.
    #expect(board.record(.accepted, for: "other", at: now) == .none)
    #expect(board.isPaused("released"))
  }

  @Test func anOutputThatWasTurnedOffStartsClean() {
    var board = HealthBoard()
    _ = board.record(.notRecognised(status: 404), for: "k", at: now)
    board.forget("k")
    #expect(board.isDue("k", at: now))
    #expect(!board.isPaused("k"))
  }
}

@Suite struct HealthPauseStatusTests {
  typealias I = StatusText.Input

  @Test func aPausedOutputSaysWhyOnItsOwnLine() {
    #expect(StatusText.outputLine(I(
      enabled: true, isMain: false, serverKnown: true, boundScreenName: "Left", showingBound: true, fps: 59.94,
      healthPaused: true)) == "Left · not recognised by the server, health paused")
    #expect(StatusText.outputLine(I(
      enabled: true, isMain: false, serverKnown: true, showingBound: true, healthPaused: true))
      == "Showing a screen · not recognised by the server, health paused")
  }

  /// A page that is not up is the bigger news, and an output on the holding screen
  /// has nothing to report health about.
  @Test func theOtherStatesWinOverAPause() {
    #expect(StatusText.outputLine(I(
      enabled: true, isMain: false, serverKnown: true, unreachable: true, showingBound: true, healthPaused: true))
      == "Cannot reach the server. Retrying")
    #expect(StatusText.outputLine(I(enabled: true, isMain: false, serverKnown: true, healthPaused: true))
      == "Waiting to be set up on the server")
  }
}

@Suite struct PortProblemStatusTests {
  typealias I = StatusText.Input

  /// A card output whose port refused the screen's format sends nothing: that is
  /// its line, beside the screen it is set up as, and it wins over the frame rate.
  @Test func aRefusedModeIsTheLine() {
    let why = "Cannot play 1080p25: the port has no 1080p25 (it offers 1080p59.94)"
    #expect(StatusText.outputLine(I(
      enabled: true, isMain: false, serverKnown: true, boundScreenName: "Wing", showingBound: true, fps: 59.94,
      portProblem: why)) == "Wing · \(why)")
    #expect(StatusText.outputLine(I(enabled: true, isMain: false, serverKnown: false, portProblem: why)) == why)
  }

  /// A card output says how far behind the page it runs, beside its frame rate;
  /// a paused one says only why it is paused.
  @Test func aCardOutputSaysItsLatency() {
    #expect(StatusText.outputLine(I(
      enabled: true, isMain: false, serverKnown: true, boundScreenName: "Wing", showingBound: true, fps: 59.94,
      latencyMs: 20.04)) == "Wing · 59.94 fps · 20 ms behind the page")
    #expect(StatusText.outputLine(I(
      enabled: true, isMain: false, serverKnown: true, boundScreenName: "Wing", showingBound: true, fps: 59.94,
      healthPaused: true, latencyMs: 20)) == "Wing · not recognised by the server, health paused")
    #expect(StatusText.outputLine(I(enabled: true, isMain: false, serverKnown: false, fps: 59.94, latencyMs: 16, testPattern: true))
      == "Latency test page · 59.94 fps · 16 ms behind the page")
  }

  /// A card output sending frames but not the page says so in place of its frame
  /// rate, which over black would read as healthy.
  @Test func aCardOutputWithNoPictureSaysSoNotItsFrameRate() {
    let line = StatusText.outputLine(I(
      enabled: true, isMain: false, serverKnown: true, boundScreenName: "Wing", showingBound: true, fps: 59.94,
      portProblem: StatusText.silenceLine(.neverDrawn), latencyMs: 20))
    #expect(line == "Wing · No picture from the page. Sending black")
    #expect(StatusText.silenceLine(.stopped) == "No new picture from the page. Reloading it")
  }

  @Test func anOutputTurnedOffSaysOnlyThat() {
    #expect(StatusText.outputLine(I(enabled: false, isMain: false, serverKnown: true, portProblem: "x")) == "Turned off here")
  }
}
