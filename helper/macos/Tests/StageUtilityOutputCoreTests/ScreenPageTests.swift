import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct ScreenPageTests {
  let server = "http://192.0.2.10:8788"

  func classify(_ url: String?, server: String? = nil) -> ScreenPage {
    ScreenPage.classify(committed: url.flatMap { URL(string: $0) }, server: server ?? self.server)
  }

  @Test func enrollIsTheHoldingScreen() {
    #expect(classify("http://192.0.2.10:8788/enroll?device=m.k&token=t") == .holding)
  }

  @Test func theRedirectTargetIsASetUpScreen() {
    #expect(classify("http://192.0.2.10:8788/main-stage?device=m.k") == .bound(outputRef: "main-stage"))
    #expect(classify("http://192.0.2.10:8788/main-stage/") == .bound(outputRef: "main-stage"))
  }

  @Test func noUrlOrNoPathIsNeither() {
    #expect(classify(nil) == .other)
    #expect(classify("http://192.0.2.10:8788") == .other)
    #expect(classify("http://192.0.2.10:8788/") == .other)
  }

  /// A page that is not the server's says nothing about whether this output is set up.
  @Test func aPageFromAnotherOriginIsNeither() {
    #expect(classify("http://192.0.2.99:8788/main-stage") == .other)
    #expect(classify("http://192.0.2.10:9000/main-stage") == .other)
    #expect(classify("https://192.0.2.10:8788/main-stage") == .other)
    #expect(classify("about:blank") == .other)
  }

  @Test func defaultPortsAndCaseAreTheSameOrigin() {
    #expect(classify("http://Stage.example/enroll", server: "http://stage.example:80") == .holding)
    #expect(classify("https://stage.example:443/x", server: "https://stage.example") == .bound(outputRef: "x"))
  }

  /// With a path in the server address, the first path component is the prefix and
  /// not a screen: reading it as one is how `/su/enroll` was taken for a set-up
  /// screen called "su". Such an address is refused (see EnrollURLTests), so no
  /// page is classified against it at all.
  @Test func aServerAddressWithAPathClassifiesNothing() {
    #expect(classify("http://192.0.2.10:8788/su/enroll?device=m.k", server: "http://192.0.2.10:8788/su") == .other)
    #expect(classify("http://192.0.2.10:8788/su/main-stage", server: "http://192.0.2.10:8788/su/") == .other)
  }

  @Test func onlyABoundPageIsBound() {
    #expect(ScreenPage.bound(outputRef: "x").isBound)
    #expect(!ScreenPage.holding.isBound)
    #expect(!ScreenPage.other.isBound)
  }
}
