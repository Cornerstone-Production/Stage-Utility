import Foundation

/// macOS asks, once, whether an app may use the local network, and an app that was
/// refused is not told: its sends and connects to LAN addresses fail with "No
/// route to host" (EHOSTUNREACH). That error also means a host really is
/// unreachable, so this is only ever a suspicion, worded as one.
///
/// Only a broadcast probe that failed on every interface is read as a denial
/// (`ProbeLinkState.sent`). A page load or a health post that gets "no route to
/// host" is a single unicast to a server, and a server that is switched off on the
/// same subnet gives the same error; the page shown for a failed load says where to
/// turn access on only with other evidence (`UnreachablePage`).
public enum LocalNetworkAccess {
  public static let hostUnreachable: Int32 = 65  // EHOSTUNREACH on Darwin

  public static let windowMessage =
    "Local Network access may be off. Turn it on in System Settings > Privacy & Security > Local Network."

  /// A POSIX error code that fits a refused permission.
  public static func looksLikeDenial(posix code: Int32) -> Bool { code == hostUnreachable }
}
