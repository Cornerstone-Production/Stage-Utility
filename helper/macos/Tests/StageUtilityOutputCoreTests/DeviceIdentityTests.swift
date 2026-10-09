import Testing
@testable import StageUtilityOutputCore

@Suite struct DeviceIdentityTests {
  let mac = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"
  let display = "37D8832A-2D66-02CA-B9F7-8F30A301B230"

  @Test func outputKeyIsTheLowercasedUUID() {
    #expect(DeviceIdentity.outputKey(displayUUID: display) == "37d8832a-2d66-02ca-b9f7-8f30a301b230")
  }

  @Test func outputKeyHasNoSeparatorOrPathCharacters() {
    #expect(DeviceIdentity.outputKey(displayUUID: "A.B/C D") == "a-b-c-d")
  }

  @Test func deviceIdIsMacDotKey() {
    let key = DeviceIdentity.outputKey(displayUUID: display)
    #expect(DeviceIdentity.deviceId(mac: mac, key: key) == "\(mac).37d8832a-2d66-02ca-b9f7-8f30a301b230")
  }

  /// The server refuses an id over 128 characters. A Mac id from a hand-edited
  /// device-id file can be any length.
  @Test func deviceIdNeverExceedsTheServersCap() {
    let key = DeviceIdentity.outputKey(displayUUID: display)
    for macLength in [1, 36, 90, 91, 127, 128, 129, 300, 5000] {
      let id = DeviceIdentity.deviceId(mac: String(repeating: "m", count: macLength), key: key)
      #expect(id.count <= DeviceIdentity.maxLength, "mac of \(macLength) gave \(id.count)")
    }
    // A long key shares the budget rather than blowing it.
    let id = DeviceIdentity.deviceId(mac: String(repeating: "m", count: 300), key: String(repeating: "k", count: 300))
    #expect(id.count <= DeviceIdentity.maxLength)
  }

  @Test func anIdThatFitsIsLeftAlone() {
    let key = String(repeating: "k", count: 64)
    let m = String(repeating: "m", count: 63)
    let id = DeviceIdentity.deviceId(mac: m, key: key)
    #expect(id == "\(m).\(key)")
    #expect(id.count == DeviceIdentity.maxLength)
  }

  /// Shortening must not make two Macs one device, nor change from run to run.
  @Test func shortenedIdsStayDistinctAndStable() {
    let prefix = String(repeating: "x", count: 200)
    let a = DeviceIdentity.deviceId(mac: prefix + "a", key: "k")
    let b = DeviceIdentity.deviceId(mac: prefix + "b", key: "k")
    #expect(a != b)
    #expect(a == DeviceIdentity.deviceId(mac: prefix + "a", key: "k"))
    // And two outputs of one Mac stay two devices.
    #expect(DeviceIdentity.deviceId(mac: prefix, key: "k1") != DeviceIdentity.deviceId(mac: prefix, key: "k2"))
  }
}
