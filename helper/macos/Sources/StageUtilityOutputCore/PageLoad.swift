import Foundation

/// What a web view's navigation events add up to: how many loads have failed in a
/// row, which of them to retry and when, and when a load that follows a failure is
/// the page being back.
///
/// The web view reports events; this decides. A 5xx is a failed load even though
/// WebKit finishes it (the error page is a page), so a navigation that got a 5xx
/// answer must not then count as loaded when WebKit says it finished.
public struct PageLoadTracker: Equatable {
  /// Consecutive failures since the last good load (0 when the page is up).
  public private(set) var failures = 0
  /// The navigation in flight got a 5xx answer. Its page is an error page: it is
  /// neither a load that succeeded nor a screen to classify.
  public private(set) var responseFailed = false

  public struct Failure: Equatable {
    public var failures: Int
    public var reason: String
    /// Seconds until the reload.
    public var delay: TimeInterval
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
    responseFailed = false
  }

  /// A load (or a reload) begins.
  public mutating func loadStarted() { responseFailed = false }

  /// The main frame's response arrived with this HTTP status.
  public mutating func responded(status: Int) -> Outcome {
    guard status >= 500 else { return .none }
    responseFailed = true
    return fail("server answered \(status)")
  }

  /// WebKit finished the navigation.
  public mutating func finished() -> Outcome {
    if responseFailed {
      // Already counted when the 5xx arrived.
      responseFailed = false
      return .none
    }
    let ended = failures
    failures = 0
    return .loaded(afterFailures: ended)
  }

  /// The navigation failed, before or after it committed.
  public mutating func navigationFailed(_ error: NSError) -> Outcome {
    // Our own load() interrupting one in flight.
    if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled { return .none }
    if responseFailed {
      // The 5xx that began it was counted; its failing is the same failure.
      responseFailed = false
      return .none
    }
    return fail(error.localizedDescription)
  }

  public mutating func processTerminated() -> Outcome { fail("web content process ended") }

  private mutating func fail(_ reason: String) -> Outcome {
    failures += 1
    return .failed(Failure(failures: failures, reason: reason, delay: Backoff.reloadDelay(failures: failures)))
  }
}
