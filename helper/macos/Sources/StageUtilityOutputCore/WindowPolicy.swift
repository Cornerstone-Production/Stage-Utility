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

  /// What the window does with a flick of an output's switch.
  public enum ToggleAction: Equatable {
    /// Do it now.
    case apply
    /// Ask first: the display with the menu bar covers the helper's icon when it
    /// comes on, so the window is no longer one click away. The person is told how
    /// to get it back before it happens. Only turning on asks; off never does.
    case confirm
  }

  public static func toggleAction(turningOn: Bool, coversMenuBar: Bool) -> ToggleAction {
    turningOn && coversMenuBar ? .confirm : .apply
  }
}

/// The shortcut that opens the helper's window from anywhere, whatever is on screen.
///
/// An output window covers its display whole, and the display with the menu bar
/// takes the helper's icon with it, so the icon cannot be the only way to the window
/// where an output is switched off. Control-Option-Command-O is registered with
/// Carbon's `RegisterEventHotKey`, which needs no permission (a global key monitor
/// would need Accessibility).
public enum HelperHotKey {
  /// The virtual key code for O (`kVK_ANSI_O`).
  public static let keyCode: UInt32 = 31
  /// Carbon's modifier masks: `controlKey` 4096, `optionKey` 2048, `cmdKey` 256.
  public static let modifiers: UInt32 = 4096 | 2048 | 256
  /// As the window and the log write it.
  public static let label = "⌃⌥⌘O"
}
