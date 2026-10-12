import Foundation

/// What the helper does when asked to quit: by its own Quit item, a quit Apple event,
/// or macOS logging out, restarting or shutting down.
///
/// There is no answer that refuses. A quit is either AppKit's own (Chromium is not
/// running, so nothing needs closing in order) or the helper's: close every port and
/// page, then end Chromium's loop and exit. An app that answers a quit with a cancel
/// cancels the logout or restart that sent it.
public enum QuitDecision: Equatable, Sendable {
  /// Chromium is not running: AppKit terminates as usual.
  case letAppKitTerminate
  /// Close every output's port and page, then end Chromium's loop; the process exits
  /// from main.
  case closeOutputsThenEndLoop
  /// A quit is already closing them: this one waits on the same exit.
  case alreadyClosing

  public static func onTerminate(engineRunning: Bool, alreadyQuitting: Bool) -> QuitDecision {
    guard engineRunning else { return .letAppKitTerminate }
    return alreadyQuitting ? .alreadyClosing : .closeOutputsThenEndLoop
  }
}
