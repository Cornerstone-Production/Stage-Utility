import Foundation

/// What the page a web view has COMMITTED is: the holding screen, a screen the
/// output is set up as, or something else.
///
/// Read the committed URL, not the one being loaded. While a load is in flight the
/// web view reports the address it is going to, so a reload of a set-up screen that
/// fails (the server is down) briefly says `/enroll` even though a screen is still
/// on display, and the output looked released and claimed again on every retry.
public enum ScreenPage: Equatable {
  /// `/enroll`: the server's holding screen, shown until the output is set up.
  case holding
  /// `/<output id or slug>`, where `/enroll` redirects once the output is set up.
  case bound(outputRef: String)
  /// Anything else: not the server's, no path, or a server address that cannot be
  /// told apart from a path (one with a prefix, which the helper refuses).
  case other

  public static func classify(committed url: URL?, server: String) -> ScreenPage {
    guard let url, let base = EnrollURL.normalise(server: server), let origin = URL(string: base),
      sameOrigin(url, origin)
    else { return .other }
    guard let first = url.path.split(separator: "/").first.map(String.init) else { return .other }
    return first == "enroll" ? .holding : .bound(outputRef: first)
  }

  private static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
    guard let sa = a.scheme?.lowercased(), let sb = b.scheme?.lowercased(), sa == sb,
      let ha = a.host?.lowercased(), let hb = b.host?.lowercased(), ha == hb
    else { return false }
    let defaultPort = sa == "https" ? 443 : 80
    return (a.port ?? defaultPort) == (b.port ?? defaultPort)
  }

  public var isBound: Bool {
    if case .bound = self { return true }
    return false
  }
}
