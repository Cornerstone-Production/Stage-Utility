import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct ProbeTests {
  let probe = Probe(
    id: "mac-id.display-key", macs: ["aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02"], hostname: "booth-mini",
    boundTo: "server-1",
    output: .init(kind: .display, name: "HDMI · LG 27UL", port: "HDMI"))

  /// The exact datagram. If this changes, the server's decodeProbe must still read
  /// it: keys sorted, no spaces, boundTo and modes absent rather than null.
  @Test func encodesToExactBytes() {
    let expected =
      #"{"boundTo":"server-1","hostname":"booth-mini","id":"mac-id.display-key","macs":["aa:bb:cc:dd:ee:01","aa:bb:cc:dd:ee:02"],"os":"macOS","output":{"kind":"display","name":"HDMI · LG 27UL","port":"HDMI"},"stageUtility":"discover","v":1}"#
    #expect(String(decoding: probe.encoded(), as: UTF8.self) == expected)
  }

  @Test func omitsBoundToWhenUnbound() {
    var p = probe
    p.boundTo = nil
    let text = String(decoding: p.encoded(), as: UTF8.self)
    #expect(!text.contains("boundTo"))
    #expect(!text.contains("null"))
  }

  /// The Linux agent's field, so another server can list this output as bound
  /// elsewhere. Absent unless true, like the Linux agent's.
  @Test func carriesUnreachableOnlyWhenTrue() {
    var p = probe
    #expect(!String(decoding: p.encoded(), as: UTF8.self).contains("unreachable"))
    p.unreachable = true
    let text = String(decoding: p.encoded(), as: UTF8.self)
    #expect(text.contains(#""unreachable":true"#))
    #expect(!text.contains("false"))
  }

  @Test func carriesModesForAPortThatHasThem() {
    var p = probe
    p.output = .init(kind: .decklink, name: "SDI 1 · DeckLink Duo 2", port: "SDI 1", modes: ["1080p59.94", "1080i59.94"])
    let text = String(decoding: p.encoded(), as: UTF8.self)
    #expect(text.contains(#""kind":"decklink""#))
    #expect(text.contains(#""modes":["1080p59.94","1080i59.94"]"#))
  }

  /// What the server would do with a longer one is cut it; do it here so the id
  /// the probe carries is the id the server stores.
  @Test func clipsToTheServersBounds() throws {
    var p = probe
    p.hostname = String(repeating: "h", count: 500)
    p.macs = (0..<12).map { "aa:bb:cc:dd:ee:\($0)" }
    let o = try #require(try JSONSerialization.jsonObject(with: p.encoded()) as? [String: Any])
    #expect((o["hostname"] as? String)?.count == Probe.maxString)
    #expect((o["macs"] as? [String])?.count == Probe.maxMacs)
    #expect(p.encoded().count < Probe.maxDatagram)
  }

  /// The server slices strings at 128 UTF-16 units. Cutting a string of emoji at 128
  /// characters would send 256 units and the server would cut it again, differently.
  @Test func clipsInUtf16UnitsAsTheServerCounts() throws {
    var p = probe
    p.hostname = String(repeating: "\u{1F600}", count: 100)
    let o = try #require(try JSONSerialization.jsonObject(with: p.encoded()) as? [String: Any])
    let host = try #require(o["hostname"] as? String)
    #expect(host.utf16.count == 128)
    #expect(host.count == 64)
    // Never half of a pair.
    #expect(String(decoding: host.utf8, as: UTF8.self) == host)
  }

  @Test func clipNeverSplitsASurrogatePair() {
    // 127 units then a pair: the pair does not fit, so 127 units remain.
    let s = String(repeating: "a", count: 127) + "\u{1F600}"
    #expect(s.clippedUTF16(to: 128).utf16.count == 127)
    #expect("abc".clippedUTF16(to: 128) == "abc")
    #expect("abcdef".clippedUTF16(to: 3) == "abc")
  }

  @Test func modesAreCutLikeTheServerCutsThem() throws {
    var p = probe
    p.output.modes = (0..<40).map { _ in String(repeating: "m", count: 50) }
    let o = try #require(try JSONSerialization.jsonObject(with: p.encoded()) as? [String: Any])
    let modes = try #require((o["output"] as? [String: Any])?["modes"] as? [String])
    #expect(modes.count == Probe.maxModes)
    #expect(modes.allSatisfy { $0.utf16.count == Probe.maxModeLength })
  }

  /// A probe over 2048 BYTES is not read at all, so the output would never appear.
  /// Multi-byte names are what get there: 3 bytes a unit, 128 units, in nine places.
  @Test func neverExceedsTheDatagramCapInBytes() {
    var p = probe
    let wide = String(repeating: "\u{20AC}", count: 128)  // 128 units, 384 bytes
    p.hostname = wide
    p.os = wide
    p.macs = (0..<8).map { _ in wide }
    p.output = .init(kind: .decklink, name: wide, port: wide, modes: (0..<24).map { _ in String(repeating: "\u{20AC}", count: 32) })
    #expect(String(decoding: p.encoded(), as: UTF8.self).utf8.count <= Probe.maxDatagram)
    #expect(p.encoded().count <= Probe.maxDatagram)
  }

  /// What goes first is the long name; the id and the binding never go.
  @Test func dropsTheNameDetailBeforeAnythingElse() throws {
    var p = probe
    p.id = "mac-id.display-key"
    p.boundTo = "server-1"
    p.output = .init(kind: .display, name: String(repeating: "\u{20AC}", count: 128), port: "HDMI")
    p.hostname = String(repeating: "\u{20AC}", count: 128)
    p.os = String(repeating: "\u{20AC}", count: 128)
    p.macs = (0..<8).map { _ in String(repeating: "\u{20AC}", count: 128) }
    let o = try #require(try JSONSerialization.jsonObject(with: p.encoded()) as? [String: Any])
    #expect(p.encoded().count <= Probe.maxDatagram)
    #expect(o["id"] as? String == "mac-id.display-key")
    #expect(o["boundTo"] as? String == "server-1")
    #expect((o["output"] as? [String: Any])?["port"] as? String == "HDMI")
    // The name fell back to the port rather than the datagram being dropped.
    #expect((o["output"] as? [String: Any])?["name"] as? String == "HDMI")
  }

  @Test func aProbeThatFitsIsNotTouched() {
    #expect(String(decoding: probe.encoded(), as: UTF8.self).contains("HDMI · LG 27UL"))
  }

  @Test func buildsFromADescriptor() {
    let d = OutputDescriptor(kind: .display, key: "k", name: "Display 2 · LG", port: "Display 2")
    let p = Probe(id: "m.k", macs: [], hostname: "h", boundTo: nil, descriptor: d)
    #expect(p.output == .init(kind: .display, name: "Display 2 · LG", port: "Display 2"))
    #expect(p.os == "macOS")
  }
}

@Suite struct ReplyTests {
  func data(_ s: String) -> Data { Data(s.utf8) }

  @Test func parsesTheServersReply() {
    let r = DiscoveryReply.parse(
      data(#"{"stageUtility":"server","v":1,"serverId":"s-1","name":"Stage Utility","url":"http://192.0.2.10:8788"}"#))
    #expect(r == DiscoveryReply(serverId: "s-1", name: "Stage Utility", url: "http://192.0.2.10:8788"))
  }

  @Test func readsWhetherTheOutputIsClaimed() {
    let base = #"{"stageUtility":"server","v":1,"serverId":"s-1","name":"S","url":"http://192.0.2.10:8788""#
    #expect(DiscoveryReply.parse(data(base + #","claimed":true}"#))?.claimed == true)
    #expect(DiscoveryReply.parse(data(base + #","claimed":false}"#))?.claimed == false)
    // An older server, and anything that is not a JSON boolean.
    #expect(DiscoveryReply.parse(data(base + "}"))?.claimed == nil)
    #expect(DiscoveryReply.parse(data(base + #","claimed":1}"#))?.claimed == nil)
    #expect(DiscoveryReply.parse(data(base + #","claimed":"true"}"#))?.claimed == nil)
  }

  @Test func nameDefaultsToTheServerId() {
    let r = DiscoveryReply.parse(data(#"{"stageUtility":"server","v":1,"serverId":"s-1","url":"http://h:1"}"#))
    #expect(r?.name == "s-1")
  }

  @Test func refusesWhatIsNotAReply() {
    #expect(DiscoveryReply.parse(data("not json")) == nil)
    #expect(DiscoveryReply.parse(data("[]")) == nil)
    // A probe, which is what another helper's broadcast looks like.
    #expect(DiscoveryReply.parse(data(#"{"stageUtility":"discover","v":1,"id":"x"}"#)) == nil)
    // Wrong version.
    #expect(DiscoveryReply.parse(data(#"{"stageUtility":"server","v":2,"serverId":"s","url":"http://h:1"}"#)) == nil)
    // Missing pieces.
    #expect(DiscoveryReply.parse(data(#"{"stageUtility":"server","v":1,"url":"http://h:1"}"#)) == nil)
    #expect(DiscoveryReply.parse(data(#"{"stageUtility":"server","v":1,"serverId":"s"}"#)) == nil)
  }

  /// The url goes into a browser, so only http(s) with a host will do.
  @Test func refusesAUrlThatIsNotHttp() {
    for url in ["file:///etc/passwd", "javascript:alert(1)", "ftp://h/", "http://", "/relative"] {
      let body = #"{"stageUtility":"server","v":1,"serverId":"s","url":"\#(url)"}"#
      #expect(DiscoveryReply.parse(data(body)) == nil, "accepted \(url)")
    }
  }

  /// The helper refuses a prefixed server, so a reply naming one is not used.
  @Test func refusesAUrlWithAPath() {
    #expect(DiscoveryReply.parse(data(#"{"stageUtility":"server","v":1,"serverId":"s","url":"http://h:1/su"}"#)) == nil)
    #expect(DiscoveryReply.parse(data(#"{"stageUtility":"server","v":1,"serverId":"s","url":"http://h:1/"}"#)) != nil)
  }

  @Test func replyLengthsCountUtf16Units() {
    // 130 emoji is 260 units: over the 128 cap on a name, so cut at 128 units.
    let name = String(repeating: "\u{1F600}", count: 130)
    let r = DiscoveryReply.parse(data(#"{"stageUtility":"server","v":1,"serverId":"s","name":"\#(name)","url":"http://h:1"}"#))
    #expect(r?.name.utf16.count == 128)
  }

  @Test func refusesAnOversizedDatagramOrUrl() {
    let long = "http://h/" + String(repeating: "a", count: 600)
    #expect(DiscoveryReply.parse(data(#"{"stageUtility":"server","v":1,"serverId":"s","url":"\#(long)"}"#)) == nil)
    let big = #"{"stageUtility":"server","v":1,"serverId":"s","url":"http://h:1","pad":"\#(String(repeating: "x", count: 3000))"}"#
    #expect(DiscoveryReply.parse(data(big)) == nil)
  }
}
