import AppKit

/// One copy at a time. A second one started by hand (not through `open`, which
/// reactivates the first by itself) would draw every output twice, over the top of
/// the first.
enum SingleInstance {
  static let showWindowRequest = Notification.Name("com.stageutility.output.showWindow")

  /// If another copy of this app is running: ask it to show its window, bring it
  /// forward, and say so. The caller exits.
  ///
  /// Keyed on the bundle id, so a build run straight from `.build/` (no bundle, no
  /// id) never defers to an installed copy.
  static func handOverToRunningCopy() -> Bool {
    guard let id = Bundle.main.bundleIdentifier else { return false }
    let me = ProcessInfo.processInfo.processIdentifier
    guard let other = NSRunningApplication.runningApplications(withBundleIdentifier: id).first(where: { $0.processIdentifier != me })
    else { return false }
    DistributedNotificationCenter.default().postNotificationName(
      showWindowRequest, object: nil, userInfo: nil, deliverImmediately: true)
    other.activate()
    // Let the notification leave before this process does.
    RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    return true
  }
}
