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
  /// an unclaimed device while a Screens page is open and a probe every two seconds
  /// for ever is noise. After an answer the probe keeps going every 30 s: the
  /// server lists an unclaimed device for 90 s after its last probe, so stopping
  /// would make the output vanish from Screens before anyone set it up. An
  /// unanswered output is listed all the same, which the 30 s rate also keeps alive.
  ///
  /// With no socket to probe from there is nothing to answer, so the slow rate: it
  /// is the rate at which a socket that failed to open is tried again.
  public static func interval(unanswered: Int, answered: Bool, socketOpen: Bool = true) -> TimeInterval {
    if !socketOpen || answered { return 30 }
    return unanswered < 10 ? 2 : 30
  }

  /// Probes sent unanswered, to a server this output is bound to, before the probe
  /// says the server cannot be reached. The Linux agent's threshold (install-linux.sh:
  /// `fails -gt 30`), so a slow boot is not reported as a fault and another server
  /// does not offer to take a screen the moment its own is briefly quiet.
  public static let unreachableAfter = 30

  /// Whether the next probe carries `unreachable: true`: bound, never answered since
  /// discovery started looking, and past the threshold.
  public static func flagsUnreachable(unanswered: Int, answered: Bool, boundTo: String?) -> Bool {
    boundTo != nil && !answered && unanswered > unreachableAfter
  }
}
