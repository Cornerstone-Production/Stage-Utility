import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct OptionsTests {
  func parse(_ args: [String], env: [String: String] = [:]) -> (Options, [String]) {
    Options.parse(["StageUtilityOutput"] + args, environment: env)
  }

  @Test func noArgumentsIsTheDefaults() {
    let (o, problems) = parse([])
    #expect(o == Options())
    #expect(o.discoveryPort == 8789)
    #expect(problems.isEmpty)
  }

  @Test func readsEveryFlag() {
    let (o, problems) = parse([
      "--show-window", "--list-outputs", "--log-stderr", "--dump-frames", "/tmp/frames", "--discovery-port", "9000",
      "--virtual-sdi", "4",
    ])
    #expect(o.showWindow && o.listOutputs && o.logToStderr)
    #expect(o.virtualSDI == 4)
    #expect(o.dumpFramesDir?.path == "/tmp/frames")
    #expect(o.discoveryPort == 9000)
    #expect(problems.isEmpty)
  }

  @Test func theInstallersPortVariableIsUsedAndTheFlagWinsOverIt() {
    #expect(parse([], env: ["STAGE_KIOSK_PORT": "8800"]).0.discoveryPort == 8800)
    #expect(parse(["--discovery-port", "9000"], env: ["STAGE_KIOSK_PORT": "8800"]).0.discoveryPort == 9000)
    #expect(parse([], env: ["STAGE_KIOSK_PORT": ""]).0.discoveryPort == 8789)
  }

  @Test func aBadPortIsAProblemAndKeepsTheDefault() {
    let (a, pa) = parse(["--discovery-port", "http"])
    #expect(a.discoveryPort == 8789)
    #expect(pa == ["--discovery-port is not a port: http"])
    #expect(parse(["--discovery-port", "0"]).1.count == 1)
    #expect(parse(["--discovery-port", "70000"]).1.count == 1)
    let (b, pb) = parse([], env: ["STAGE_KIOSK_PORT": "x"])
    #expect(b.discoveryPort == 8789)
    #expect(pb == ["STAGE_KIOSK_PORT is not a port: x"])
  }

  @Test func virtualOutputsAreOffUnlessAskedForAndBounded() {
    #expect(parse([]).0.virtualSDI == 0)
    #expect(parse(["--virtual-sdi", "16"]).0.virtualSDI == 16)
    for bad in ["0", "17", "-1", "four"] {
      let (o, problems) = parse(["--virtual-sdi", bad])
      #expect(o.virtualSDI == 0)
      #expect(problems == ["--virtual-sdi takes 1 to 16: \(bad)"])
    }
  }

  @Test func aFlagWithoutItsValueIsAProblem() {
    #expect(parse(["--dump-frames"]).1 == ["--dump-frames needs a value"])
    #expect(parse(["--discovery-port"]).1 == ["--discovery-port needs a value"])
  }

  /// An unknown flag must not be ignored: a typo in a LaunchAgent would otherwise
  /// leave the helper running without the option it was started with.
  @Test func anUnknownArgumentIsAProblem() {
    #expect(parse(["--shw-window"]).1 == ["unknown argument: --shw-window"])
  }

  @Test func aValueIsNotReadAsAFlag() {
    // The path after --dump-frames is consumed, not checked against the flags.
    let (o, problems) = parse(["--dump-frames", "--show-window"])
    #expect(o.dumpFramesDir?.lastPathComponent == "--show-window")
    #expect(!o.showWindow)
    #expect(problems.isEmpty)
  }
}
