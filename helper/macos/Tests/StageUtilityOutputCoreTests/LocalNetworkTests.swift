import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct LocalNetworkTests {
  @Test func noRouteToHostIsASuspectedDenial() {
    #expect(LocalNetworkAccess.looksLikeDenial(posix: 65))
    #expect(!LocalNetworkAccess.looksLikeDenial(posix: 61))  // connection refused: the host is there
    #expect(!LocalNetworkAccess.looksLikeDenial(posix: 0))
  }

  @Test func aSendIsADenialOnlyWhenEveryTargetFailedThatWay() {
    #expect(LocalNetworkAccess.looksLikeDenial(sendErrors: [65, 65], targets: 2))
    #expect(!LocalNetworkAccess.looksLikeDenial(sendErrors: [65], targets: 2))
    #expect(!LocalNetworkAccess.looksLikeDenial(sendErrors: [65, 13], targets: 2))
    #expect(!LocalNetworkAccess.looksLikeDenial(sendErrors: [], targets: 2))
    #expect(!LocalNetworkAccess.looksLikeDenial(sendErrors: [], targets: 0))
  }

  @Test func readsThePosixCodeOutOfAPageLoadError() {
    let direct = NSError(domain: NSPOSIXErrorDomain, code: 65)
    #expect(LocalNetworkAccess.looksLikeDenial(direct))
    let stream = NSError(
      domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost,
      userInfo: ["_kCFStreamErrorDomainKey": 1, "_kCFStreamErrorCodeKey": 65])
    #expect(LocalNetworkAccess.looksLikeDenial(stream))
    let nested = NSError(
      domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet,
      userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: 65)])
    #expect(LocalNetworkAccess.looksLikeDenial(nested))
  }

  @Test func otherLoadErrorsAreNotSuspected() {
    #expect(!LocalNetworkAccess.looksLikeDenial(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)))
    #expect(!LocalNetworkAccess.looksLikeDenial(NSError(domain: NSPOSIXErrorDomain, code: 61)))
    // Another stream domain with a coincidentally equal code.
    #expect(!LocalNetworkAccess.looksLikeDenial(
      NSError(domain: NSURLErrorDomain, code: -1, userInfo: ["_kCFStreamErrorDomainKey": 4, "_kCFStreamErrorCodeKey": 65])))
  }
}
