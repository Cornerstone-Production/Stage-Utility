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
      "--virtual-sdi", "4", "--test-pattern", "latency", "--frame-timings", "/tmp/t.csv", "--head-start", "10.5",
      "--fill-lead", "5",
    ])
    #expect(o.showWindow && o.listOutputs && o.logToStderr)
    #expect(o.virtualSDI == 4)
    #expect(o.testPattern == .latency)
    #expect(o.frameTimingsFile?.path == "/tmp/t.csv")
    #expect(o.headStartMs == 10.5)
    #expect(o.fillLeadMs == 5)
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

  @Test func anUnknownTestPatternOrABadLeadIsAProblem() {
    let (a, pa) = parse(["--test-pattern", "bars"])
    #expect(a.testPattern == nil)
    #expect(pa == ["--test-pattern takes latency: bars"])
    for bad in ["0", "-3", "1000", "soon"] {
      let (o, problems) = parse(["--head-start", bad])
      #expect(o.headStartMs == nil)
      #expect(problems == ["--head-start takes milliseconds, more than 0 and less than 1000: \(bad)"])
    }
  }

  /// The pair the leads make is checked when the flags are read, with the standard
  /// for the one not given: a fill lead under the card's 3.5 ms would skip every
  /// slot, and one not shorter than the head start leaves the page no time and the
  /// port would never open. Either refuses to start, saying why.
  @Test func leadsThatCannotRunAreRefusedAtTheStart() {
    #expect(parse(["--head-start", "16", "--fill-lead", "4"]).1.isEmpty)
    #expect(parse(["--fill-lead", "3.5"]).1.isEmpty)
    #expect(
      parse(["--fill-lead", "3"]).1 == [
        "--fill-lead must be at least 3.5 ms, the least before its slot a card takes a frame on time: 3"
      ])
    #expect(
      parse(["--head-start", "5"]).1 == [
        "--fill-lead (5 ms) must be less than --head-start (5 ms), or the page has no time to draw"
      ])
    #expect(
      parse(["--head-start", "8", "--fill-lead", "9"]).1 == [
        "--fill-lead (9 ms) must be less than --head-start (8 ms), or the page has no time to draw"
      ])
    #expect(
      parse(["--fill-lead", "25"]).1 == [
        "--fill-lead (25 ms) must be less than --head-start (20 ms), or the page has no time to draw"
      ])
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
