import StageUtilityOutputCore
import WebKit

/// WebKit stops painting a window macOS thinks is hidden: a locked screen, an
/// asleep display, a window off every display. An output must keep painting
/// through all three, so these four private switches are turned off.
///
/// They are SPI and can change in any macOS release, which is the main upkeep this
/// helper carries. Each is set by `BoolSwitch` (core, tested), which checks it with
/// `responds(to:)` and reads it back; one that is missing, or does not take, is
/// reported to the caller to log and show in the window.
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
    preferenceSwitches.compactMap { BoolSwitch.turnOff($0.setter, getter: $0.getter, on: preferences) }
  }

  /// The occlusion switch, on the web view itself.
  static func apply(to webView: WKWebView) -> [String] {
    [BoolSwitch.turnOff(occlusionSwitch.setter, getter: occlusionSwitch.getter, on: webView)].compactMap { $0 }
  }
}
