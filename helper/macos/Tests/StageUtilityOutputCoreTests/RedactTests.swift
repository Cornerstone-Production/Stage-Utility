import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct RedactTests {
  static let token = "5eedfeed0123456789abcdef0123456789abcdef01234567"
  static let enroll = EnrollURL.make(
    server: "http://192.0.2.10:8788", deviceId: "mac-1.decklink-1a2b-0", token: token)!

  /// The whole path a failed load takes to the log: the browser's report made into
  /// the error the tracker reads, the reason the tracker gives, and the line
  /// `SurfaceLoader` writes with it, through the filter every log line passes.
  /// Neither the reason nor the line carries the token, or `token=` at all.
  @Test func aFailedEnrollLoadNeverPutsTheTokenInTheReasonOrTheLog() throws {
    var tracker = PageLoadTracker()
    let error = PageLoadTracker.navigationError(
      code: -102, text: "net::ERR_CONNECTION_REFUSED", url: Self.enroll.absoluteString)
    guard case .failed(let failure) = tracker.navigationFailed(error) else {
      Issue.record("a refused connection is a failed load")
      return
    }
    #expect(failure.reason == "net::ERR_CONNECTION_REFUSED loading http://192.0.2.10:8788/enroll")
    let line = Redact.addresses(
      in: "SDI 1: page did not load (\(failure.reason)); reload \(failure.failures) in \(Int(failure.delay)) s")
    for text in [failure.reason, line] {
      #expect(!text.contains("token="), "\(text)")
      #expect(!text.contains(Self.token), "\(text)")
    }
  }

  /// The filter every log line passes: an address anywhere in a line loses its
  /// query and fragment (the enroll address, wrapped in a reason's parentheses), a
  /// user and password, and a token written without its address.
  @Test func anAddressInAnyLineLosesItsQuery() {
    let raw = Self.enroll.absoluteString
    #expect(
      Redact.addresses(in: "SDI 1: page did not load (net::ERR_FAILED loading \(raw)); reload 1 in 2 s")
        == "SDI 1: page did not load (net::ERR_FAILED loading http://192.0.2.10:8788/enroll); reload 1 in 2 s")
    #expect(Redact.addresses(in: "at \(raw)#top then") == "at http://192.0.2.10:8788/enroll then")
    #expect(Redact.addresses(in: "server http://op:pw@192.0.2.10:8788 answered") == "server http://192.0.2.10:8788 answered")
    #expect(Redact.addresses(in: "loading /enroll?device=a&token=\(Self.token)") == "loading /enroll?device=a")
    #expect(!Redact.addresses(in: "TOKEN=\(Self.token)").contains(Self.token))
  }

  /// A server's address, which is all a line about a server carries, comes through
  /// as it is.
  @Test func aServerAddressIsLeftAsItIs() {
    #expect(Redact.url("http://192.0.2.10:8788") == "http://192.0.2.10:8788")
    #expect(Redact.url(Self.enroll) == "http://192.0.2.10:8788/enroll")
    #expect(Redact.addresses(in: "the server file names http://192.0.2.10:8788; probes go to it") == "the server file names http://192.0.2.10:8788; probes go to it")
    #expect(Redact.url("not an address") == "not an address")
  }
}
