import Foundation
import Testing
@testable import StageUtilityOutputCore

/// The page an output shows when its page did not load, in place of Chromium's error
/// page, which printed the whole address and its token on air.
///
/// Not tested here, because it needs Chromium running: that the browser host hides
/// Chromium's error page until this one commits (CEFHost `Blank`), and that the
/// output then draws this page. Both were driven with a card output's frame dumps.
@Suite struct UnreachablePageTests {
  static let token = "9f2c1e0d4b7a68352f1e0d9c8b7a6f5e4d3c2b1a09f8e7d6"
  static let target = URL(string: "http://192.168.1.50:8788/enroll?device=mac-1.decklink-ab-0&token=\(token)")!

  /// Everything the browser is given: the page as text, and the address that holds it.
  func shown(_ content: UnreachablePage.Content) -> [String] {
    let url = UnreachablePage.url(content)
    let base64 = String(url.absoluteString.split(separator: ",", maxSplits: 1)[1])
    let html = String(decoding: Data(base64Encoded: base64)!, as: UTF8.self)
    return [html, url.absoluteString] + UnreachablePage.lines(content)
  }

  @Test(arguments: [-109, -102, -105, -118, -21, -7])
  func theScreenNamesTheServerAndNothingElseOfTheAddress(netError: Int) {
    let content = UnreachablePage.content(
      target: Self.target, netError: netError, evidence: .init(serverAnswered: true, broadcastsBlocked: true))
    #expect(content.headline == "Can't reach 192.168.1.50:8788")
    for text in shown(content) {
      #expect(!text.contains(Self.token))
      #expect(!text.contains("token"))
      #expect(!text.contains("device="))
      #expect(!text.contains("mac-1"))
      #expect(!text.contains("/enroll"))
    }
    let html = shown(content)[0]
    #expect(html.contains("Can't reach 192.168.1.50:8788"))
  }

  @Test func theServerIsNamedByHostAndPortOnly() {
    #expect(UnreachablePage.serverLabel(URL(string: "http://stage.local/enroll?token=x")!) == "stage.local")
    #expect(UnreachablePage.serverLabel(URL(string: "http://[fe80::1]:8788/enroll?token=x")!) == "[fe80::1]:8788")
    #expect(UnreachablePage.serverLabel(URL(string: "http://user:pw@192.0.2.1:8788/x?token=y#z")!) == "192.0.2.1:8788")
  }

  // MARK: The Local Network line

  func hint(_ host: String, _ error: Int, answered: Bool = true, blocked: Bool = false) -> Bool {
    UnreachablePage.content(
      target: URL(string: "http://\(host)/enroll?device=d&token=t")!, netError: error,
      evidence: .init(serverAnswered: answered, broadcastsBlocked: blocked)
    ).localNetwork
  }

  /// Unreachable, on the local network, and the server is known not to be simply off.
  @Test func theLineIsShownForAnUnreachableLANServerThatIsUp() {
    #expect(hint("192.168.1.50:8788", -109))
    #expect(hint("10.0.0.5:8788", -109))
    #expect(hint("172.20.1.1:8788", -109))
    #expect(hint("169.254.3.4:8788", -109))
    #expect(hint("stage.local:8788", -109))
    #expect(hint("[fd00::5]:8788", -109))
    #expect(hint("[fe80::1]:8788", -109))
    #expect(hint("192.168.1.50:8788", -109, answered: false, blocked: true))
    let content = UnreachablePage.content(
      target: Self.target, netError: -109, evidence: .init(serverAnswered: true, broadcastsBlocked: false))
    #expect(UnreachablePage.lines(content).contains(UnreachablePage.localNetworkLine))
    #expect(shown(content)[0].contains("System Settings &gt; Privacy &amp; Security &gt; Local Network"))
  }

  /// A server switched off on the same subnet gives the same error. With nothing
  /// saying it is up, the screen only says it cannot be reached.
  @Test func theLineIsNotShownWithoutEvidence() {
    #expect(!hint("192.168.1.50:8788", -109, answered: false, blocked: false))
  }

  @Test func theLineIsOnlyForAnUnreachableAddress() {
    for error in [-102, -105, -118, -7, -21, -106] { #expect(!hint("192.168.1.50:8788", error)) }
  }

  /// Loopback is exempt from Local Network privacy, and the internet is not the
  /// local network.
  @Test func theLineIsOnlyForTheLocalNetwork() {
    for host in ["127.0.0.1:8788", "[::1]:8788", "localhost:8788", "203.0.113.5:8788", "172.32.0.1:8788",
      "192.169.0.1:8788", "100.64.0.1:8788", "[2001:db8::1]:8788", "stage.example.com:8788"]
    {
      #expect(!hint(host, -109), "\(host)")
    }
    let content = UnreachablePage.content(target: Self.target, netError: -102, evidence: .none)
    #expect(UnreachablePage.lines(content) == ["Can't reach 192.168.1.50:8788", UnreachablePage.retryingLine])
  }
}
