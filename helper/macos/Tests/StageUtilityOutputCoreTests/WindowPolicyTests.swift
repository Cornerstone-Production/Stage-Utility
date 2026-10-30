import Carbon.HIToolbox
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

@Suite struct HelperHotKeyTests {
  /// The numbers are written out in the core library, which does not link Carbon, so
  /// this is where they are held to Carbon's own.
  @Test func isControlOptionCommandO() {
    #expect(HelperHotKey.keyCode == UInt32(kVK_ANSI_O))
    #expect(HelperHotKey.modifiers == UInt32(controlKey | optionKey | cmdKey))
    #expect(HelperHotKey.label == "⌃⌥⌘O")
  }

  /// A key that needs no other: a plain letter, or one modifier, would be typed or
  /// used by every app, and the combination must not be one macOS keeps for itself.
  @Test func needsThreeModifiersSoNoAppTypesIt() {
    let m = HelperHotKey.modifiers
    #expect(m & UInt32(controlKey) != 0 && m & UInt32(optionKey) != 0 && m & UInt32(cmdKey) != 0)
    #expect(m & UInt32(shiftKey) == 0)
  }

  @Test func onlyTurningOnTheDisplayWithTheMenuBarAsksFirst() {
    #expect(HelperWindowPolicy.toggleAction(turningOn: true, coversMenuBar: true) == .confirm)
    #expect(HelperWindowPolicy.toggleAction(turningOn: true, coversMenuBar: false) == .apply)
    // Switching it off is how the person gets the icon back: never in the way.
    #expect(HelperWindowPolicy.toggleAction(turningOn: false, coversMenuBar: true) == .apply)
    #expect(HelperWindowPolicy.toggleAction(turningOn: false, coversMenuBar: false) == .apply)
  }
}
