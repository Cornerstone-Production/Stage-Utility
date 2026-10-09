import Foundation

/// macOS asks, once, whether an app may use the local network, and an app that was
/// refused is not told: its sends and connects to LAN addresses fail with "No
/// route to host" (EHOSTUNREACH). That error also means a host really is
/// unreachable, so this is only ever a suspicion, worded as one.
public enum LocalNetworkAccess {
  public static let hostUnreachable: Int32 = 65  // EHOSTUNREACH on Darwin

  public static let windowMessage =
    "Local Network access may be off. Turn it on in System Settings > Privacy & Security > Local Network."

  /// A POSIX error code that fits a refused permission.
  public static func looksLikeDenial(posix code: Int32) -> Bool { code == hostUnreachable }

  /// A probe send that failed on EVERY target with "no route to host" is a denial;
  /// one dead interface among several working ones is not.
  public static func looksLikeDenial(sendErrors: [Int32], targets: Int) -> Bool {
    targets > 0 && sendErrors.count == targets && sendErrors.allSatisfy(looksLikeDenial(posix:))
  }

  /// The POSIX code inside an `NSError` from a page load, if there is one: WebKit
  /// and CFNetwork carry it as `_kCFStreamErrorCodeKey` (domain 1 is POSIX) or as an
  /// underlying NSPOSIXErrorDomain error.
  public static func posixCode(in error: NSError) -> Int32? {
    if error.domain == NSPOSIXErrorDomain { return Int32(error.code) }
    if let domain = error.userInfo["_kCFStreamErrorDomainKey"] as? Int, domain == 1,
      let code = error.userInfo["_kCFStreamErrorCodeKey"] as? Int
    {
      return Int32(code)
    }
    if let inner = error.userInfo[NSUnderlyingErrorKey] as? NSError { return posixCode(in: inner) }
    return nil
  }

  public static func looksLikeDenial(_ error: NSError) -> Bool {
    posixCode(in: error).map(looksLikeDenial(posix:)) ?? false
  }
}
