import Foundation
import Testing
@testable import StageUtilityOutputCore

/// The file the updater reads to know a new helper started. Its shape is read by a
/// shell script (`helper_status_field` in install-macos.sh), so the bytes matter:
/// one line, sorted keys, slashes not escaped.
@Suite struct HelperStatusTests {
  @Test func isOneLineTheInstallerCanRead() throws {
    let s = HelperStatus(version: "1.27.0", pid: 812, chromium: .started, server: "http://192.0.2.10:8788")
    let text = try #require(String(data: s.encoded(), encoding: .utf8))
    #expect(text == #"{"chromium":"started","localNetworkRefused":false,"pid":812,"server":"http://192.0.2.10:8788","version":"1.27.0"}"#)
  }

  @Test func saysWhyChromiumDidNotStart() throws {
    let s = HelperStatus(version: "1.27.0", pid: 1, chromium: .failed, chromiumProblem: "the browser host could not be opened")
    let text = try #require(String(data: s.encoded(), encoding: .utf8))
    #expect(text.contains(#""chromium":"failed""#))
    #expect(text.contains(#""chromiumProblem":"the browser host could not be opened""#))
  }

  @Test func theServerIsItsRootAndNothingElse() {
    // An output's address carries its device id and token: none of it is written.
    #expect(HelperStatus.serverRoot(of: "http://192.0.2.10:8788/enroll?device=abc&token=secret") == "http://192.0.2.10:8788")
    #expect(HelperStatus.serverRoot(of: "http://stage.local") == "http://stage.local")
    #expect(HelperStatus.serverRoot(of: "https://stage.example.org:8443/x#frag") == "https://stage.example.org:8443")
    #expect(HelperStatus.serverRoot(of: "file:///etc/passwd") == nil)
    #expect(HelperStatus.serverRoot(of: "not a url") == nil)
  }
}
