import Foundation

/// When the helper's own window should be on screen without being asked for.
///
/// The helper is a menu bar app: its window opens from its icon. An output window
/// sits above the menu bar (`mainMenu + 1`) so it can cover the display whole, and
/// when it covers the display that has the menu bar, the icon is under it. With
/// nothing else on that Mac to click, there is then no way back to the window,
/// which is the one place an output is switched off.
public enum HelperWindowPolicy {
  /// Whether the window opens at launch: when asked for (`--show-window`), on a
  /// first run (no `outputs.json` yet, so there is nothing set up to be quiet
  /// about), or when an output covers the menu bar.
  public static func opensAtLaunch(showWindowFlag: Bool, hasStateFile: Bool, menuBarCovered: Bool) -> Bool {
    showWindowFlag || !hasStateFile || menuBarCovered
  }

  /// Whether a change in the displays should bring the window up: the menu bar has
  /// just become covered. Not while it stays covered, or the window would come back
  /// every time a display arrangement changed.
  public static func opensOnChange(wasCovered: Bool, isCovered: Bool) -> Bool {
    isCovered && !wasCovered
  }
}
