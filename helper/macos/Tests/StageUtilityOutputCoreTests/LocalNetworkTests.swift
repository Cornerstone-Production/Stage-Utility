import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct LocalNetworkTests {
  @Test func noRouteToHostIsASuspectedDenial() {
    #expect(LocalNetworkAccess.looksLikeDenial(posix: 65))
    #expect(!LocalNetworkAccess.looksLikeDenial(posix: 61))  // connection refused: the host is there
    #expect(!LocalNetworkAccess.looksLikeDenial(posix: 0))
  }
}
