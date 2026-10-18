import Foundation

/// The switches the app gives Chromium's browser process, each `name` or
/// `name=value` without the leading dashes. The browser host appends them as they
/// are (`su_cef_settings.switches`); they live here so a test can hold them.
public enum ChromiumSwitches {
  /// Chromium's network service, in the app's own process.
  ///
  /// macOS decides Local Network access per process, by the app the process belongs
  /// to. Chromium runs its network service, which makes every page's connections, in
  /// a helper app of its own (`StageUtilityOutput Helper.app`), and macOS treats that
  /// helper as an app apart from Stage Utility Output: the permission the operator
  /// gave the app does not cover it, and it is refused with no prompt. Every load
  /// from a server on the LAN then fails with ERR_ADDRESS_UNREACHABLE while the app's
  /// own discovery, in the main process, works. In the browser process the network
  /// service's connections are the app's, under the one permission the operator sees
  /// in System Settings. Loopback is exempt, which is why a server on the same Mac
  /// never showed it. `GPUProcessWatch` logs it if a network service process appears
  /// anyway.
  static let networkServiceInProcess = "enable-features=NetworkServiceInProcess2"

  public static let browser: [String] = [
    // os_crypt would otherwise ask for the login keychain, a prompt nobody at an
    // output Mac is there to answer.
    "use-mock-keychain",
    // A display output keeps drawing when macOS thinks its window is hidden: a
    // locked screen, an asleep display. These are public Chromium switches.
    "disable-backgrounding-occluded-windows",
    "disable-renderer-backgrounding",
    "disable-background-timer-throttling",
    networkServiceInProcess,
  ]
}
