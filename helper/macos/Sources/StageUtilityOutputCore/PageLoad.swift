import Foundation

/// What a browser's navigation events add up to: how many loads have failed in a
/// row, which of them to retry and when, and when a load that follows a failure is
/// the page being back.
///
/// The browser reports events; this decides. A 5xx is a failed load even though the
/// browser finishes it (the error page is a page), so a navigation that got a 5xx
/// answer must not then count as loaded when the browser says it finished. Nor may
/// one that failed after it committed: Chromium reports that failure and then
/// finishes the same navigation.
public struct PageLoadTracker: Equatable {
  /// Consecutive failures since the last good load (0 when the page is up).
  public private(set) var failures = 0
  /// The navigation in flight got a 5xx answer. Its page is an error page: it is
  /// neither a load that succeeded nor a screen to classify.
  public private(set) var responseFailed = false
  /// The navigation in flight failed and was counted. Its finishing, if the browser
  /// reports one, is the end of that failure, not a load.
  public private(set) var failedInFlight = false
  /// The helper's own page for a failed load is up (`UnreachablePage`), until the
  /// next load starts. What the browser reports about it is not the server's page:
  /// it neither commits a screen nor ends the run of failures.
  public private(set) var showingFailurePage = false
  /// The reason last written to the log in this run of failures.
  private var loggedReason: String?

  public struct Failure: Equatable {
    public var failures: Int
    public var reason: String
    /// Seconds until the reload.
    public var delay: TimeInterval
    /// Whether to log it: the first failure of a run, or one whose reason differs
    /// from the last logged. A retry that fails the same way is not a new line.
    public var log: Bool
  }

  public enum Outcome: Equatable {
    case none
    /// Count it, say it, and reload after `delay`.
    case failed(Failure)
    /// The page loaded. `afterFailures` is the run it ended (0 when there was none).
    case loaded(afterFailures: Int)
  }

  public init() {}

  /// A new address was asked for: nothing from the old one carries over.
  public mutating func reset() {
    failures = 0
    loggedReason = nil
    loadStarted()
  }

  /// A load (or a reload) begins.
  public mutating func loadStarted() {
    responseFailed = false
    failedInFlight = false
    showingFailurePage = false
  }

  /// The helper's own page for the failure is being shown in the browser.
  public mutating func failurePageShown() { showingFailurePage = true }

  /// Whether a page that committed is one to report: not a 5xx's, and not the
  /// helper's own failure page.
  public var reportsCommit: Bool { !responseFailed && !showingFailurePage }

  /// The main frame's response arrived with this HTTP status.
  public mutating func responded(status: Int) -> Outcome {
    guard !showingFailurePage, status >= 500 else { return .none }
    responseFailed = true
    return fail("server answered \(status)")
  }

  /// The browser finished the navigation.
  public mutating func finished() -> Outcome {
    if showingFailurePage { return .none }
    if responseFailed || failedInFlight {
      // Already counted when the 5xx or the failure arrived.
      responseFailed = false
      failedInFlight = false
      return .none
    }
    let ended = failures
    failures = 0
    loggedReason = nil
    return .loaded(afterFailures: ended)
  }

  /// The navigation failed, before or after it committed.
  public mutating func navigationFailed(_ error: NSError) -> Outcome {
    // Our own load() interrupting one in flight.
    if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled { return .none }
    if showingFailurePage { return .none }
    if responseFailed {
      // The 5xx that began it was counted; its failing is the same failure.
      responseFailed = false
      return .none
    }
    failedInFlight = true
    return fail(error.localizedDescription)
  }

  public mutating func processTerminated() -> Outcome { fail("the page's renderer process ended") }

  /// What a browser reports when a navigation fails, as `navigationFailed` reads it:
  /// the engine's own words for the error, and where the page was going, by its
  /// scheme, host and path only. The address an output loads carries its token
  /// (`EnrollURL`), and this reason is written to the log (`Redact`).
  public static func navigationError(code: Int, text: String, url: String) -> NSError {
    // net::ERR_ABORTED: our own load replacing one in flight, not the server failing.
    if code == abortedCode { return NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled) }
    return NSError(
      domain: netErrorDomain, code: code, userInfo: [NSLocalizedDescriptionKey: "\(text) loading \(Redact.url(url))"])
  }

  /// The domain of a Chromium net error from `navigationError`.
  public static let netErrorDomain = "net"

  /// net::ERR_ABORTED, in Chromium's net_error_list.h.
  public static let abortedCode = -3

  private mutating func fail(_ reason: String) -> Outcome {
    failures += 1
    let log = reason != loggedReason
    if log { loggedReason = reason }
    return .failed(
      Failure(failures: failures, reason: reason, delay: Backoff.reloadDelay(failures: failures), log: log))
  }
}
