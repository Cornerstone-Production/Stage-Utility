import Foundation
import Testing
@testable import StageUtilityOutputCore

/// The file the updater reads to know a new helper started. Its shape is read by a
/// shell script (`json_field` in install-macos.sh), so the bytes matter:
/// one line, sorted keys, slashes not escaped.
@Suite struct HelperStatusTests {
  @Test func isOneLineTheInstallerCanRead() throws {
    let s = HelperStatus(version: "1.27.0", pid: 812, chromium: .started)
    let text = try #require(String(data: s.encoded(), encoding: .utf8))
    #expect(text == #"{"chromium":"started","localNetworkRefused":false,"pid":812,"version":"1.27.0"}"#)
  }

  @Test func saysWhyChromiumDidNotStart() throws {
    let s = HelperStatus(version: "1.27.0", pid: 1, chromium: .failed, chromiumProblem: "the browser host could not be opened")
    let text = try #require(String(data: s.encoded(), encoding: .utf8))
    #expect(text.contains(#""chromium":"failed""#))
    #expect(text.contains(#""chromiumProblem":"the browser host could not be opened""#))
  }
}
