import DeckLinkShim
import Foundation
import StageUtilityOutputCore
import Testing
@testable import DeckLinkKit

@Suite struct DriverTests {
  static let framework = "/Library/Frameworks/DeckLinkAPI.framework"

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
      #expect(status.problem == "Desktop Video is not installed, so there are no DeckLink outputs")
      #expect(DeckLinkDriver.ports().isEmpty)
    }
  }

  @Test func openingAPortWithoutTheDriverSaysWhy() throws {
    try #require(!FileManager.default.fileExists(atPath: Self.framework), "Desktop Video is installed here")
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

  /// The driver's state is logged when it changes, not on every scan: the helper
  /// scans at launch and on every device change.
  @Test func theInventoryLogsOnlyWhatChanged() {
    let log = LogLines()
    let duo = DeckLinkPort(
      id: DeckLinkPortID(persistentID: 7, subDevice: 0), displayName: "DeckLink Duo (1)", modelName: "", modes: [])
    let reading = Locked<(DeckLinkDriver.Status, [DeckLinkPort])>((.notInstalled, []))
    let inventory = DeckLinkInventory(read: { reading.value }, log: log.write)

    _ = inventory.scan()
    _ = inventory.scan()
    reading.value = (.installed(version: "14.2"), [duo])
    #expect(inventory.scan().ports == [duo])
    _ = inventory.scan()
    reading.value = (.installed(version: "14.2"), [])
    _ = inventory.scan()
    #expect(
      log.lines == [
        "Desktop Video is not installed, so there are no DeckLink outputs",
        "Desktop Video 14.2: 1 output port: DeckLink Duo (1) (decklink-7-0)",
        "Desktop Video 14.2: 0 output ports",
      ])
  }

  /// The real reader on this Mac: no driver, so one line saying so.
  @Test func theInventoryOnThisMac() throws {
    try #require(!FileManager.default.fileExists(atPath: Self.framework), "Desktop Video is installed here")
    let log = LogLines()
    let inventory = DeckLinkInventory(log: log.write)
    #expect(inventory.scan().ports.isEmpty)
    _ = inventory.scan()
    #expect(log.lines == ["Desktop Video is not installed, so there are no DeckLink outputs"])
  }
}
