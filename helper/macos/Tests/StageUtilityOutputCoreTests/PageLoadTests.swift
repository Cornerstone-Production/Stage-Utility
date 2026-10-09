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
    #expect(t.finished() == .loaded(afterFailures: 2))
    #expect(t.failures == 0)
  }

  /// WebKit finishes a navigation that got a 5xx: the error page is a page. That
  /// must stay a failure, or the retry backoff resets and the window reads "up".
  @Test func aFiveHundredIsAFailureEvenThoughWebKitFinishesIt() {
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

  @Test func aDeadWebContentProcessIsAFailure() {
    var t = PageLoadTracker()
    let f = failure(t.processTerminated())
    #expect(f?.failures == 1)
    #expect(f?.reason == "web content process ended")
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
}
