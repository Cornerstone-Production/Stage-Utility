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

  /// The url goes into a web view, so only http(s) with a host will do.
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

  @Test func refusesAnOversizedDatagramOrUrl() {
    let long = "http://h/" + String(repeating: "a", count: 600)
    #expect(DiscoveryReply.parse(data(#"{"stageUtility":"server","v":1,"serverId":"s","url":"\#(long)"}"#)) == nil)
    let big = #"{"stageUtility":"server","v":1,"serverId":"s","url":"http://h:1","pad":"\#(String(repeating: "x", count: 3000))"}"#
    #expect(DiscoveryReply.parse(data(big)) == nil)
  }
}
