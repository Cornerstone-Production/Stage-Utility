import Foundation
import Testing
@testable import StageUtilityOutputCore

/// Stands in for WKPreferences: a setter by selector name taking a BOOL, with a
/// getter to read it back.
final class FakeSwitches: NSObject {
  @objc var throttling = true
  @objc var recordedCalls = 0
  /// What the setter was handed, as a full 64-bit register rather than a BOOL: a real
  /// false leaves it 0, and a pointer passed in a BOOL's place is anything but.
  @objc var received = -1
  @objc func setRawFlag(_ value: Int) { received = value }
  /// Exists, accepts the call, and does nothing: a switch WebKit stopped honouring.
  @objc var stuck: Bool {
    get { true }
    set { recordedCalls += 1 }
  }
}

@Suite struct BoolSwitchTests {
  /// The setter is called and the switch ends off. This does NOT catch the
  /// `perform(_:with:)` regression, which can pass here when the pointer it sends
  /// happens to have a zero low byte (measured: it does); the whole-register test below
  /// is the one that does.
  @Test func theSetterIsCalledWithARealFalse() {
    let object = FakeSwitches()
    #expect(object.throttling)
    let problem = BoolSwitch.turnOff("setThrottling:", getter: "throttling", on: object)
    #expect(problem == nil)
    #expect(!object.throttling)
  }

  /// A BOOL setter that read back as false would also pass for a pointer whose low
  /// byte happened to be zero, which is luck. Seen as the whole register, the argument
  /// of a call made with `perform(_:with:)` is the NSNumber's address, never 0.
  @Test func theArgumentIsZeroInTheWholeRegisterNotJustItsLowByte() {
    let object = FakeSwitches()
    _ = BoolSwitch.turnOff("setRawFlag:", getter: "noGetterByThisName", on: object)
    #expect(object.received == 0)
  }

  @Test func aSetterThatIsNotThereIsNamed() {
    let object = FakeSwitches()
    #expect(BoolSwitch.turnOff("_setNoSuchSwitch:", getter: "noSuchSwitch", on: object) == "_setNoSuchSwitch:")
  }

  @Test func aSetterThatDoesNotTakeIsReported() {
    let object = FakeSwitches()
    #expect(BoolSwitch.turnOff("setStuck:", getter: "stuck", on: object) == "setStuck: (did not take)")
    #expect(object.recordedCalls == 1)
  }

  @Test func aSwitchWithNoGetterIsTrustedOnceCalled() {
    let object = FakeSwitches()
    #expect(BoolSwitch.turnOff("setThrottling:", getter: "noGetterByThisName", on: object) == nil)
    #expect(!object.throttling)
  }
}
