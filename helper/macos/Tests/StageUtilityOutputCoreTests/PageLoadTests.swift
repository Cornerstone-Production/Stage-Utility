import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct PageLoadTrackerTests {
  func failure(_ o: PageLoadTracker.Outcome) -> PageLoadTracker.Failure? {
    if case .failed(let f) = o { return f }
    return nil
  }

  @Test func aCleanLoadIsLoadedWithNoFailuresBehindIt() {
    var t = PageLoadTracker()
    #expect(t.finished() == .loaded(afterFailures: 0))
  }

  /// 2, 4, 8, 16, then 30 for good: the delay comes from the run, not the clock.
  @Test func eachFailureInARunWaitsLonger() {
    var t = PageLoadTracker()
    let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
    let delays = (1...6).map { _ in failure(t.navigationFailed(error))?.delay }
    #expect(delays == [2, 4, 8, 16, 30, 30])
    #expect(t.failures == 6)
  }

  @Test func theLoadThatEndsARunSaysHowLongTheRunWas() {
    var t = PageLoadTracker()
    _ = t.navigationFailed(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
    _ = t.navigationFailed(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
    // Every retry is a new load (SurfaceLoader.reload).
    t.loadStarted()
    #expect(t.finished() == .loaded(afterFailures: 2))
    #expect(t.failures == 0)
  }

  /// A browser finishes a navigation that got a 5xx: the error page is a page. That
  /// must stay a failure, or the retry backoff resets and the window reads "up".
  @Test func aFiveHundredIsAFailureEvenThoughTheBrowserFinishesIt() {
    var t = PageLoadTracker()
    let f = failure(t.responded(status: 503))
    #expect(f?.failures == 1)
    #expect(f?.reason == "server answered 503")
    #expect(t.responseFailed)
    #expect(t.finished() == .none)
    #expect(t.failures == 1)
    #expect(!t.responseFailed)
  }

  @Test func theFailureAfterAFiveHundredIsNotCountedTwice() {
    var t = PageLoadTracker()
    _ = t.responded(status: 502)
    #expect(t.navigationFailed(NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost)) == .none)
    #expect(t.failures == 1)
  }

  @Test func anythingBelowFiveHundredIsLeftAlone() {
    var t = PageLoadTracker()
    for status in [200, 302, 400, 401, 404, 499] { #expect(t.responded(status: status) == .none) }
    #expect(t.failures == 0)
    #expect(!t.responseFailed)
  }

  /// Our own reload interrupting a load in flight is not the server failing.
  @Test func aCancelledLoadIsNotAFailure() {
    var t = PageLoadTracker()
    #expect(t.navigationFailed(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)) == .none)
    #expect(t.failures == 0)
  }

  @Test func aDeadRendererIsAFailure() {
    var t = PageLoadTracker()
    let f = failure(t.processTerminated())
    #expect(f?.failures == 1)
    #expect(f?.reason == "the page's renderer process ended")
  }

  /// Chromium reports a navigation that fails after it committed, then finishes it.
  /// The finish must not read as the page being up: that would reset the backoff on
  /// every retry, so discovery would never run again for a server that moved.
  @Test func aFailureAfterCommitIsNotUndoneByTheFinishThatFollowsIt() {
    var t = PageLoadTracker()
    for n in 1...3 {
      t.loadStarted()
      #expect(failure(t.navigationFailed(NSError(domain: "net", code: -101)))?.failures == n)
      #expect(t.finished() == .none)
    }
    #expect(t.failures == 3)
    t.loadStarted()
    #expect(t.finished() == .loaded(afterFailures: 3))
  }

  @Test func askingForANewAddressStartsTheRunOver() {
    var t = PageLoadTracker()
    _ = t.responded(status: 500)
    _ = t.navigationFailed(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
    t.reset()
    #expect(t.failures == 0)
    #expect(!t.responseFailed)
    #expect(t.finished() == .loaded(afterFailures: 0))
  }

  /// A 5xx whose navigation never finished must not make the next, good, load
  /// read as an error page.
  @Test func aNewLoadClearsAStaleFiveHundred() {
    var t = PageLoadTracker()
    _ = t.responded(status: 500)
    t.loadStarted()
    #expect(t.finished() == .loaded(afterFailures: 1))
  }

  /// The helper's own page goes up in place of a failed load. The browser reports it
  /// committing and finishing like any page; that is not the server coming back, so
  /// the run and its backoff go on, and its address is not a screen to classify.
  /// Chromium may also finish the failed navigation itself first: both finishes are
  /// reported, and neither is a load.
  @Test func theFailurePageIsNotThePageComingBack() {
    var t = PageLoadTracker()
    for n in 1...3 {
      t.loadStarted()
      #expect(failure(t.navigationFailed(NSError(domain: "net", code: -109)))?.failures == n)
      t.failurePageShown()
      #expect(!t.reportsCommit)
      #expect(t.responded(status: 0) == .none)
      #expect(t.finished() == .none)  // the failed navigation's
      #expect(t.finished() == .none)  // the failure page's
      #expect(t.navigationFailed(NSError(domain: "net", code: -2)) == .none)
    }
    #expect(t.failures == 3)
    // The retry is a new load: it reports again.
    t.loadStarted()
    #expect(t.reportsCommit)
    #expect(t.finished() == .loaded(afterFailures: 3))
  }

  /// A run of failures is written once, and again only when its reason changes: a
  /// retry every 30 s for an hour is not 120 lines.
  @Test func aRunOfFailuresIsLoggedOncePerReason() {
    var t = PageLoadTracker()
    let unreachable = PageLoadTracker.navigationError(code: -109, text: "ERR_ADDRESS_UNREACHABLE", url: "http://192.0.2.1:8788/enroll?token=s")
    let refused = PageLoadTracker.navigationError(code: -102, text: "ERR_CONNECTION_REFUSED", url: "http://192.0.2.1:8788/enroll?token=s")
    var logged: [Bool] = []
    for error in [unreachable, unreachable, unreachable, refused, refused, unreachable] {
      t.loadStarted()
      logged.append(failure(t.navigationFailed(error))?.log ?? false)
    }
    #expect(logged == [true, false, false, true, false, true])
    // The page coming back ends the run: the next failure is a new run, and logged.
    t.loadStarted()
    _ = t.finished()
    t.loadStarted()
    #expect(failure(t.navigationFailed(unreachable))?.log == true)
  }
}
