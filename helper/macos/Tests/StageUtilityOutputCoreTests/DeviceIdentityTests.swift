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

  /// The cap is the server's JavaScript string length: UTF-16 code units. An emoji is
  /// two, so 100 of them is 200 even though Swift counts 100.
  @Test func theCapCountsUtf16UnitsNotCharacters() {
    let emoji = String(repeating: "\u{1F600}", count: 100)
    #expect(emoji.count == 100)
    let id = DeviceIdentity.deviceId(mac: emoji, key: "k")
    #expect(id.utf16.count <= DeviceIdentity.maxLength, "gave \(id.utf16.count) units")
    // A device id of 60 emoji (120 units) and a key fits: 120 + 1 + 1.
    let fits = String(repeating: "\u{1F600}", count: 60)
    #expect(DeviceIdentity.deviceId(mac: fits, key: "k") == "\(fits).k")
    // 64 of them is 128 units before the key: over.
    let over = String(repeating: "\u{1F600}", count: 64)
    #expect(DeviceIdentity.deviceId(mac: over, key: "k") != "\(over).k")
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
