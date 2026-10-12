import DeckLinkShim
import Foundation
import StageUtilityOutputCore
import Testing
@testable import DeckLinkKit

/// Some of these run the real dispatch against this Mac, with Desktop Video
/// installed or not; each such test says which it needs, and is skipped on a Mac
/// that has the other, rather than failing there.
@Suite struct DriverTests {
  static let framework = "/Library/Frameworks/DeckLinkAPI.framework"
  static var installed: Bool { FileManager.default.fileExists(atPath: framework) }

  /// Runs the real dispatch against this Mac. Where Desktop Video is not
  /// installed (the build machine has none), the driver must read as not
  /// installed, list no ports and refuse to open one, all without crashing; where
  /// it is, it must read as installed.
  @Test func theDriverIsWhatIsOnDisk() {
    let status = DeckLinkDriver.status()
    if FileManager.default.fileExists(atPath: Self.framework) {
      if case .installed = status {} else { Issue.record("the framework is installed but the driver reads \(status)") }
    } else {
      #expect(status == .notInstalled)
      #expect(status.problem == "Desktop Video is not installed, so there are no DeckLink outputs; install it and restart the helper")
      #expect(DeckLinkDriver.ports().isEmpty)
    }
  }

  @Test(.enabled(if: !DriverTests.installed, "needs a Mac without Desktop Video"))
  func openingAPortWithoutTheDriverSaysWhy() throws {
    var port = DeckLinkPortID(persistentID: 1, subDevice: 0).shim
    var callbacks = dl_callbacks()
    var why = [CChar](repeating: 0, count: 256)
    let output = dl_output_open(&port, 0x4870_3539, &callbacks, &why, why.count)
    #expect(output == nil)
    #expect(String(cString: why) == "Desktop Video is not installed")
    #expect(dl_watch_devices(nil, nil) == false)
  }

  @Test func theVersionReadsAsDottedNumbers() {
    #expect(DeckLinkDriver.versionText(0x0c04_0100) == "12.4.1")
    #expect(DeckLinkDriver.versionText(0x0e00_0000) == "14.0")
    #expect(DeckLinkDriver.versionText(0) == "unknown")
  }

  @Test func aPortsKeyIsItsPersistentIdAndSubDevice() {
    #expect(DeckLinkPortID(persistentID: 0x1a2b_3c4d, subDevice: 2).outputKey == "decklink-1a2b3c4d-2")
    #expect(DeckLinkPortID(persistentID: nil, topologicalID: 0x300, subDevice: 0).outputKey == "decklink-t300-0")
    #expect(DeckLinkPortID(persistentID: -1, subDevice: 0).outputKey == "decklink-ffffffffffffffff-0")
    // Inside the characters a device id may carry.
    let key = DeckLinkPortID(persistentID: -1, subDevice: 3).outputKey
    #expect(DeviceIdentity.outputKey(displayUUID: key) == key)
  }

  @Test func aPortDescribesItselfWithTheModesItCanSend() {
    let p59 = CardMode(
      code: 1, driverName: "1080p59.94", width: 1920, height: 1080, frameDuration: 1001, timeScale: 60000,
      field: .progressive, supportsYUV8: true)
    let port = DeckLinkPort(
      id: DeckLinkPortID(persistentID: 7, subDevice: 1), displayName: "DeckLink Duo (2)", modelName: "DeckLink Duo",
      modes: [p59])
    #expect(
      port.descriptor
        == OutputDescriptor(
          kind: .decklink, key: "decklink-7-1", name: "DeckLink Duo (2)", port: "DeckLink Duo (2)",
          modes: ["1080p59.94"]))
  }

  static let p59 = CardMode(
    code: 1, driverName: "1080p59.94", width: 1920, height: 1080, frameDuration: 1001, timeScale: 60000,
    field: .progressive, supportsYUV8: true)

  /// The driver's state is logged when it changes, not on every scan: the helper
  /// scans at launch, on every device change and every ten seconds.
  @Test func theInventoryLogsOnlyWhatChanged() {
    let log = LogLines()
    let duo = DeckLinkPort(
      id: DeckLinkPortID(persistentID: 7, subDevice: 0), displayName: "DeckLink Duo (1)", modelName: "",
      modes: [Self.p59])
    let reading = Locked<(DeckLinkDriver.Status, [DeckLinkPort])>((.notInstalled, []))
    let inventory = DeckLinkInventory(read: { reading.value }, log: log.write)

    #expect(inventory.scan().changed)
    #expect(!inventory.scan().changed)
    reading.value = (.installed(version: "14.2"), [duo])
    #expect(inventory.scan().ports == [duo])
    #expect(!inventory.scan().changed)
    reading.value = (.installed(version: "14.2"), [])
    _ = inventory.scan()
    #expect(
      log.lines == [
        "Desktop Video is not installed, so there are no DeckLink outputs; install it and restart the helper",
        "Desktop Video 14.2: 1 output port: DeckLink Duo (1) (decklink-7-0)",
        "Desktop Video 14.2: 0 output ports",
      ])
  }

  /// The outputs to announce are every port found since launch: one unplugged
  /// stays (its port retries), one plugged in is added after the others, and a
  /// port found again carries its latest modes.
  @Test func theSeenPortsAreKeptAcrossAnUnplug() {
    let p50 = CardMode(
      code: 2, driverName: "1080p50", width: 1920, height: 1080, frameDuration: 1000, timeScale: 50000,
      field: .progressive, supportsYUV8: true)
    func port(_ id: Int64, _ modes: [CardMode] = [p50]) -> DeckLinkPort {
      DeckLinkPort(id: DeckLinkPortID(persistentID: id, subDevice: 0), displayName: "P\(id)", modelName: "", modes: modes)
    }
    let p59 = Self.p59
    let reading = Locked<(DeckLinkDriver.Status, [DeckLinkPort])>((.installed(version: "14.2"), [port(1), port(2)]))
    let inventory = DeckLinkInventory(read: { reading.value }, log: LogLines().write)
    _ = inventory.scan()
    reading.value = (.installed(version: "14.2"), [port(2)])
    _ = inventory.scan()
    #expect(inventory.seen.map(\.displayName) == ["P1", "P2"])
    reading.value = (.installed(version: "14.2"), [port(3), port(1, [p59])])
    _ = inventory.scan()
    #expect(inventory.seen.map(\.displayName) == ["P1", "P2", "P3"])
    #expect(inventory.seen[0].modes == [p59])
  }

  /// A port that can play none of its modes is set as an input in Desktop Video
  /// Setup: listed apart, never announced, and announced from the scan that finds
  /// it can play, with a line saying so. The 8K Pro's connectors are each an input
  /// or an output; Desktop Video 16.4 lists an input's modes and refuses them all.
  @Test func aPortSetAsAnInputIsNotAnOutputUntilItCanPlay() {
    var refused = Self.p59
    refused.supportsYUV8 = false
    func port(_ sub: Int64, _ modes: [CardMode]) -> DeckLinkPort {
      DeckLinkPort(
        id: DeckLinkPortID(persistentID: 0x10 + sub, subDevice: sub), displayName: "DeckLink 8K Pro (\(sub + 1))",
        modelName: "DeckLink 8K Pro", modes: modes)
    }
    let log = LogLines()
    let reading = Locked<(DeckLinkDriver.Status, [DeckLinkPort])>(
      (.installed(version: "16.4"), [port(0, [Self.p59]), port(1, [refused]), port(2, [refused])]))
    let inventory = DeckLinkInventory(read: { reading.value }, log: log.write)
    let first = inventory.scan()
    #expect(first.ports.map(\.displayName) == ["DeckLink 8K Pro (1)"])
    #expect(inventory.seen.map(\.displayName) == ["DeckLink 8K Pro (1)"])
    #expect(inventory.inputs.map(\.displayName) == ["DeckLink 8K Pro (2)", "DeckLink 8K Pro (3)"])

    // Port 2 set as an output in Desktop Video Setup: the next scan announces it.
    reading.value = (.installed(version: "16.4"), [port(0, [Self.p59]), port(1, [Self.p59]), port(2, [refused])])
    #expect(inventory.scan().changed)
    #expect(inventory.seen.map(\.displayName) == ["DeckLink 8K Pro (1)", "DeckLink 8K Pro (2)"])
    #expect(inventory.inputs.map(\.displayName) == ["DeckLink 8K Pro (3)"])
    #expect(!inventory.scan().changed)

    // A fourth connector appears, set as an input: only the inputs change, and the
    // window has to list it.
    reading.value = (
      .installed(version: "16.4"), [port(0, [Self.p59]), port(1, [Self.p59]), port(2, [refused]), port(3, [])]
    )
    #expect(inventory.scan().changed)
    #expect(inventory.inputs.map(\.displayName) == ["DeckLink 8K Pro (3)", "DeckLink 8K Pro (4)"])
    #expect(
      log.lines == [
        "Desktop Video 16.4: 1 output port: DeckLink 8K Pro (1) (decklink-10-0); set as inputs in Desktop Video Setup: "
          + "DeckLink 8K Pro (2) (decklink-11-1), DeckLink 8K Pro (3) (decklink-12-2)",
        "Desktop Video 16.4: 2 output ports: DeckLink 8K Pro (1) (decklink-10-0), DeckLink 8K Pro (2) (decklink-11-1); "
          + "set as inputs in Desktop Video Setup: DeckLink 8K Pro (3) (decklink-12-2)",
        "Desktop Video 16.4: 2 output ports: DeckLink 8K Pro (1) (decklink-10-0), DeckLink 8K Pro (2) (decklink-11-1); "
          + "set as inputs in Desktop Video Setup: DeckLink 8K Pro (3) (decklink-12-2), DeckLink 8K Pro (4) (decklink-13-3)",
      ])
  }

  /// An output switched to an input in Desktop Video Setup while the helper runs
  /// is an input from the next scan: no longer announced, so its output is closed,
  /// rather than retried for ever with "does not play ... in 8-bit YUV". Set as an
  /// output again, it is announced again.
  @Test func anOutputSetAsAnInputIsAnInputFromTheNextScan() {
    var refused = Self.p59
    refused.supportsYUV8 = false
    func port(_ modes: [CardMode]) -> DeckLinkPort {
      DeckLinkPort(
        id: DeckLinkPortID(persistentID: 0x10, subDevice: 0), displayName: "DeckLink 8K Pro (1)",
        modelName: "DeckLink 8K Pro", modes: modes)
    }
    let log = LogLines()
    let reading = Locked<(DeckLinkDriver.Status, [DeckLinkPort])>((.installed(version: "16.4"), [port([Self.p59])]))
    let inventory = DeckLinkInventory(read: { reading.value }, log: log.write)
    _ = inventory.scan()
    #expect(inventory.seen.map(\.displayName) == ["DeckLink 8K Pro (1)"])

    reading.value = (.installed(version: "16.4"), [port([refused])])
    #expect(inventory.scan().changed)
    #expect(inventory.seen.isEmpty)
    #expect(inventory.inputs.map(\.displayName) == ["DeckLink 8K Pro (1)"])

    reading.value = (.installed(version: "16.4"), [port([Self.p59])])
    #expect(inventory.scan().changed)
    #expect(inventory.seen.map(\.displayName) == ["DeckLink 8K Pro (1)"])
    #expect(inventory.inputs.isEmpty)
    #expect(
      log.lines == [
        "Desktop Video 16.4: 1 output port: DeckLink 8K Pro (1) (decklink-10-0)",
        "Desktop Video 16.4: 0 output ports; set as inputs in Desktop Video Setup: DeckLink 8K Pro (1) (decklink-10-0)",
        "Desktop Video 16.4: 1 output port: DeckLink 8K Pro (1) (decklink-10-0)",
      ])
  }

  /// With the driver and no card at that id: the open fails and says why, and
  /// there is a driver to watch for devices.
  @Test(.enabled(if: DriverTests.installed, "needs Desktop Video"))
  func openingAPortThatIsNotThereSaysWhy() throws {
    var port = DeckLinkPortID(persistentID: 0x5eed_0001, subDevice: 9).shim
    var callbacks = dl_callbacks()
    var why = [CChar](repeating: 0, count: 256)
    let output = dl_output_open(&port, 0x4870_3539, &callbacks, &why, why.count)
    #expect(output == nil)
    #expect(String(cString: why) == "the port is not connected")
    #expect(dl_watch_devices(nil, nil) == true)
  }

  /// The real reader on this Mac, scanned twice: one line, saying the driver is
  /// missing, or which version it is and how many ports it has.
  @Test func theInventoryOnThisMac() throws {
    let log = LogLines()
    let inventory = DeckLinkInventory(log: log.write)
    let ports = inventory.scan().ports
    _ = inventory.scan()
    #expect(log.lines.count == 1)
    if Self.installed {
      let line = try #require(log.lines.first)
      #expect(line.hasPrefix("Desktop Video ") && line.contains(": \(ports.count) output port"), "\(line)")
    } else {
      #expect(ports.isEmpty)
      #expect(log.lines == ["Desktop Video is not installed, so there are no DeckLink outputs; install it and restart the helper"])
    }
  }
}
