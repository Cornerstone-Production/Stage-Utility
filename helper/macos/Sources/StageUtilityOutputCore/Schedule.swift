import Foundation

/// Reload and discovery timing. Pure, so the numbers can be tested.
public enum Backoff {
  /// Seconds to wait before the next reload after `failures` in a row (1 for the
  /// first): 2, 4, 8, 16, then 30 for good.
  public static func reloadDelay(failures: Int) -> TimeInterval {
    let n = max(1, failures)
    if n >= 5 { return 30 }
    return TimeInterval(2 << (n - 1))
  }

  /// Consecutive failures that mean the address may have changed and discovery
  /// should run again.
  public static let rediscoverAfterFailures = 3

  /// Whether the `n`th failure in a row is the one that crosses the line. Exactly
  /// that one, not every one after it: discovery restarts once, not once per retry.
  public static func shouldRediscover(afterFailureNumber n: Int) -> Bool { n == rediscoverAfterFailures }
}

public enum ProbeSchedule {
  /// Seconds until the next probe.
  ///
  /// Every 2 s until the server answers, as the shell agent does; backing off to
  /// 30 s after ten unanswered ones, as it does, because the server only answers
  /// an unclaimed device while somebody is scanning and a probe every two seconds
  /// for ever is noise. After an answer the probe keeps going every 30 s: the
  /// server lists an unclaimed device for 90 s after its last probe, so stopping
  /// would make the output vanish from Screens before anyone set it up.
  public static func interval(unanswered: Int, answered: Bool) -> TimeInterval {
    if answered { return 30 }
    return unanswered < 10 ? 2 : 30
  }
}
