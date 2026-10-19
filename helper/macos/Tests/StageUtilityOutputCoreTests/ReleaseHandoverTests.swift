import Foundation
import Testing
@testable import StageUtilityOutputCore

/// One output handed from server A to server B by releasing it on A, over the exact
/// datagrams in Fixtures/release-handover.json. The server's responder test proves the
/// server sends those replies to those probes; this proves the helper sends those
/// probes and acts on those replies through the calls OutputDiscovery and AppModel
/// make: the probe carries the stored `boundTo`, `ReplyFilter.decide` judges an
/// answer, and `OutputStateStore.apply` saves what a believed one changes.
@Suite struct ReleaseHandoverTests {
  struct Fixture: Decodable {
    struct Device: Decodable {
      struct Output: Decodable { var name: String; var port: String }
      var id: String
      var macs: [String]
      var hostname: String
      var output: Output
    }
    var device: Device
    var probes: [String: String]
    var replies: [String: String]
  }

  /// Read from the repository, not bundled: the server's test reads the same file. A
  /// fixture that cannot be found is a failure, not a skip.
  static func fixture() throws -> Fixture {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<3 { url.deleteLastPathComponent() }
    return try JSONDecoder().decode(
      Fixture.self, from: Data(contentsOf: url.appendingPathComponent("Fixtures/release-handover.json")))
  }

  /// One output's discovery, over a real state store.
  struct Output {
    static let key = "sdi-1"
    let fixture: Fixture
    let store: OutputStateStore
    var filter = ReplyFilter()

    init(in dir: URL, boundTo: String?) throws {
      fixture = try ReleaseHandoverTests.fixture()
      store = OutputStateStore(directory: dir, makeToken: { "token" })
      _ = try store.ensure(key: Self.key, defaultEnabled: true)
      try store.setBoundTo(boundTo, key: Self.key)
    }

    var boundTo: String? { store.record(for: Self.key)?.boundTo }

    /// The probe it sends now.
    func probe() -> String {
      let d = fixture.device
      let descriptor = OutputDescriptor(kind: .decklink, key: Self.key, name: d.output.name, port: d.output.port)
      return String(
        decoding: Probe(id: d.id, macs: d.macs, hostname: d.hostname, boundTo: boundTo, descriptor: descriptor).encoded(),
        as: UTF8.self)
    }

    /// Hear a reply; true when it was believed.
    mutating func hear(_ name: String) throws -> Bool {
      let datagram = try #require(fixture.replies[name], "no reply \(name) in the fixture")
      let reply = try #require(DiscoveryReply.parse(Data(datagram.utf8)), "the helper could not read \(name)")
      guard case .accept(let change) = filter.decide(reply, boundTo: boundTo) else { return false }
      try store.apply(change, key: Self.key)
      return true
    }
  }

  @Test func releasedOnAItIsSetUpOnB() throws {
    try withTempDir { dir in
      let f = try Self.fixture()
      var output = try Output(in: dir, boundTo: "srv-a")
      #expect(output.probe() == f.probes["boundToA"])

      // Claimed on A: A's answer is believed, and B's is not.
      #expect(try output.hear("aClaimed"))
      #expect(try !output.hear("bUnclaimed"))
      #expect(output.boundTo == "srv-a")

      // Released on A. The output forgets A, and its probe stops naming it, which is
      // what B needs to list and answer it.
      #expect(try output.hear("aReleased"))
      #expect(output.boundTo == nil)
      #expect(output.probe() == f.probes["unbound"])

      // B answers while its Screens page is open: believed, and followed, but not
      // remembered, because B has not set it up.
      #expect(try output.hear("bUnclaimed"))
      #expect(output.boundTo == nil)
      #expect(output.filter.following == "srv-b")

      // Set up on B: remembered, and A is no longer believed.
      #expect(try output.hear("bClaimed"))
      #expect(output.boundTo == "srv-b")
      #expect(output.probe() == f.probes["boundToB"])
      #expect(try !output.hear("aReleased"))
      #expect(try !output.hear("aClaimed"))

      // Saved, so a restarted helper still names B.
      #expect(OutputStateStore(directory: dir).record(for: Output.key)?.boundTo == "srv-b")
    }
  }

  /// An unbound output A is following moves to B when B sets it up, even with A still
  /// answering: an operator claimed it on B.
  @Test func aClaimMovesAnOutputFromTheServerItWasFollowing() throws {
    try withTempDir { dir in
      var output = try Output(in: dir, boundTo: nil)
      #expect(try output.hear("aReleased"))
      #expect(try !output.hear("bUnclaimed"))
      #expect(output.filter.following == "srv-a")
      #expect(try output.hear("bClaimed"))
      #expect(output.boundTo == "srv-b")
    }
  }
}
