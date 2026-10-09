import Testing
@testable import StageUtilityOutputCore

@Suite struct HelperWindowPolicyTests {
  @Test func staysQuietOnceSetUpWithTheMenuBarFree() {
    #expect(!HelperWindowPolicy.opensAtLaunch(showWindowFlag: false, hasStateFile: true, menuBarCovered: false))
  }

  @Test func opensWhenAskedAndOnAFirstRun() {
    #expect(HelperWindowPolicy.opensAtLaunch(showWindowFlag: true, hasStateFile: true, menuBarCovered: false))
    #expect(HelperWindowPolicy.opensAtLaunch(showWindowFlag: false, hasStateFile: false, menuBarCovered: false))
  }

  /// A covered menu bar hides the icon: with no window there is no way back to it.
  @Test func opensWhenAnOutputCoversTheMenuBar() {
    #expect(HelperWindowPolicy.opensAtLaunch(showWindowFlag: false, hasStateFile: true, menuBarCovered: true))
  }

  @Test func opensOnlyWhenTheMenuBarBecomesCovered() {
    #expect(HelperWindowPolicy.opensOnChange(wasCovered: false, isCovered: true))
    #expect(!HelperWindowPolicy.opensOnChange(wasCovered: true, isCovered: true))
    #expect(!HelperWindowPolicy.opensOnChange(wasCovered: true, isCovered: false))
    #expect(!HelperWindowPolicy.opensOnChange(wasCovered: false, isCovered: false))
  }
}
