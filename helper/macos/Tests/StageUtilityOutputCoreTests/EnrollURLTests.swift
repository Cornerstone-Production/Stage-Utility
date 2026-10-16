import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct EnrollURLTests {
  @Test func buildsTheEnrollUrl() {
    let url = EnrollURL.make(server: "http://192.0.2.10:8788", deviceId: "mac.disp", token: "abc123")
    #expect(url?.absoluteString == "http://192.0.2.10:8788/enroll?device=mac.disp&token=abc123")
  }

  @Test func dropsTrailingSlashesAndWhitespace() {
    let url = EnrollURL.make(server: " http://host:8788//\n", deviceId: "d", token: "t")
    #expect(url?.absoluteString == "http://host:8788/enroll?device=d&token=t")
  }

  /// A server file written by hand says "host:8788", not a URL.
  @Test func assumesHttpWhenThereIsNoScheme() {
    #expect(EnrollURL.make(server: "booth.local:8788", deviceId: "d", token: "t")?.absoluteString
      == "http://booth.local:8788/enroll?device=d&token=t")
    #expect(EnrollURL.make(server: "https://su.example", deviceId: "d", token: "t")?.absoluteString
      == "https://su.example/enroll?device=d&token=t")
  }

  @Test func escapesWhatWouldBreakTheQuery() {
    let url = EnrollURL.make(server: "http://h:1", deviceId: "a b&c+d", token: "t=1")
    #expect(url?.absoluteString == "http://h:1/enroll?device=a%20b%26c%2Bd&token=t%3D1")
  }

  @Test func refusesAnEmptyServer() {
    #expect(EnrollURL.make(server: "  \n", deviceId: "d", token: "t") == nil)
    #expect(EnrollURL.normalise(server: "") == nil)
  }

  @Test func hostIsWhatAProbeIsSentTo() {
    #expect(EnrollURL.host(of: "booth.local:8788") == "booth.local")
    #expect(EnrollURL.host(of: "http://192.0.2.10:8788/") == "192.0.2.10")
    #expect(EnrollURL.host(of: "http://192.0.2.10:8788/su") == nil)
  }

  @Test func displayAddressIsHostAndPort() {
    #expect(EnrollURL.displayAddress("http://192.0.2.10:8788/") == "192.0.2.10:8788")
    #expect(EnrollURL.displayAddress("https://su.example") == "su.example")
  }

  /// The server redirects /enroll to "/<screen>" and its pages load "/assets/...":
  /// all root-relative, so under a prefix they leave it. Refused, with what to use.
  @Test func refusesAServerAddressWithAPath() {
    #expect(EnrollURL.normalise(server: "http://192.0.2.10:8788/su") == nil)
    #expect(EnrollURL.make(server: "192.0.2.10:8788/su/", deviceId: "d", token: "t") == nil)
    #expect(EnrollURL.normalise(server: "http://192.0.2.10:8788/?x=1") == nil)
    guard case .failure(let refusal) = EnrollURL.check(server: "http://192.0.2.10:8788/su") else {
      Issue.record("accepted a prefixed address")
      return
    }
    #expect(refusal == .notAtTheRoot(given: "http://192.0.2.10:8788/su", use: "http://192.0.2.10:8788"))
    #expect(refusal.description.contains(#"use "http://192.0.2.10:8788""#))
  }

  @Test func aBareSlashIsNotAPath() {
    #expect(EnrollURL.normalise(server: "http://192.0.2.10:8788/") == "http://192.0.2.10:8788")
  }

  @Test func saysWhyAnAddressIsRefused() {
    #expect(EnrollURL.check(server: "  ") == .failure(.empty))
    #expect(EnrollURL.check(server: "http://") == .failure(.noHost("http://")))
  }
}
