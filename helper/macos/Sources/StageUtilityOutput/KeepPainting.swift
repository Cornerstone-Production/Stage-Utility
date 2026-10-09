import WebKit

/// WebKit stops painting a window macOS thinks is hidden: a locked screen, an
/// asleep display, a window off every display. An output must keep painting
/// through all three, so these four private switches are turned off.
///
/// They are SPI and can change in any macOS release, which is the main upkeep this
/// helper carries. Each is checked with `responds(to:)` and read back after it is
/// set; one that is missing, or does not take, is reported to the caller to log and
/// show in the window.
enum KeepPainting {
  private static let preferenceSwitches: [(setter: String, getter: String)] = [
    ("_setHiddenPageDOMTimerThrottlingEnabled:", "_hiddenPageDOMTimerThrottlingEnabled"),
    ("_setHiddenPageDOMTimerThrottlingAutoIncreases:", "_hiddenPageDOMTimerThrottlingAutoIncreases"),
    ("_setPageVisibilityBasedProcessSuppressionEnabled:", "_pageVisibilityBasedProcessSuppressionEnabled"),
  ]
  private static let occlusionSwitch = (setter: "_setWindowOcclusionDetectionEnabled:", getter: "_windowOcclusionDetectionEnabled")

  /// The three preferences. Call on the configuration's preferences BEFORE the web
  /// view is made. Returns what could not be turned off.
  static func apply(to preferences: WKPreferences) -> [String] {
    preferenceSwitches.compactMap { turnOff($0.setter, getter: $0.getter, on: preferences) }
  }

  /// The occlusion switch, on the web view itself.
  static func apply(to webView: WKWebView) -> [String] {
    [turnOff(occlusionSwitch.setter, getter: occlusionSwitch.getter, on: webView)].compactMap { $0 }
  }

  /// nil when it worked; else the selector's name.
  private static func turnOff(_ setter: String, getter: String, on object: NSObject) -> String? {
    let selector = Selector(setter)
    guard object.responds(to: selector), let imp = object.method(for: selector) else { return setter }
    // `perform(_:with: false)` would box the Bool into an NSNumber and pass its
    // POINTER as the BOOL, which reads as true: it turns nothing off. Call the
    // method with a real ObjCBool.
    typealias SetBool = @convention(c) (AnyObject, Selector, ObjCBool) -> Void
    unsafeBitCast(imp, to: SetBool.self)(object, selector, ObjCBool(false))
    // Read it back where WebKit offers a getter. A setter that exists but did not
    // take is as bad as a missing one.
    if object.responds(to: Selector(getter)), let v = object.value(forKey: getter) as? Bool, v {
      return "\(setter) (did not take)"
    }
    return nil
  }
}
