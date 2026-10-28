import Testing
@testable import StageUtilityOutputCore

/// The switches the browser host gives Chromium. What they do is only seen with
/// Chromium running (driven: no `network.mojom.NetworkService` child process, and a
/// LAN page loads under the app's own Local Network permission); this holds the list
/// the host is given, and `GPUProcessWatch` logs a network service process at run time
/// if the host ever stops applying it.
@Suite struct ChromiumSwitchesTests {
  /// Without it Chromium's network service runs in a helper app that macOS does not
  /// count under the app's Local Network permission, and every page from a server
  /// on the LAN fails with ERR_ADDRESS_UNREACHABLE.
  @Test func theNetworkServiceRunsInTheAppsOwnProcess() {
    #expect(ChromiumSwitches.browser.contains("enable-features=NetworkServiceInProcess2"))
  }

  /// Chromium reads one --enable-features; a second would replace the first.
  @Test func featuresAreEnabledByOneSwitch() {
    #expect(ChromiumSwitches.browser.filter { $0.hasPrefix("enable-features=") }.count == 1)
    #expect(ChromiumSwitches.browser.allSatisfy { !$0.hasPrefix("-") && !$0.isEmpty })
  }
}
