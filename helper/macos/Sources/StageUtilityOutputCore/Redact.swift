import Foundation

/// What of an address may be written to the log or a reason: its scheme, host,
/// port and path, never its query or fragment.
///
/// The address every output loads is `<server>/enroll?device=<id>&token=<token>`
/// (`EnrollURL`), and the token is the secret the server pins for that output. The
/// unified log is readable by any administrator on the Mac and travels in every
/// sysdiagnose, so a token there is a token handed out.
///
/// Every line `Log` writes passes through `addresses(in:)`, so an address that
/// reaches a line by some path nobody thought of is cut there too; the places that
/// knowingly log an address cut it themselves with `url(_:)` first.
public enum Redact {
  /// `http://192.0.2.10:8788/enroll` for
  /// `http://192.0.2.10:8788/enroll?device=<id>&token=<token>`. A user name or
  /// password in the address goes too. Text that is not an address is returned with
  /// any address inside it cut (`addresses(in:)`).
  public static func url(_ text: String) -> String {
    guard let url = URL(string: text), url.scheme != nil else { return addresses(in: text) }
    return self.url(url)
  }

  public static func url(_ url: URL) -> String {
    guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return addresses(in: url.absoluteString)
    }
    parts.query = nil
    parts.fragment = nil
    parts.user = nil
    parts.password = nil
    return parts.string ?? addresses(in: url.absoluteString)
  }

  /// `text` with the query and fragment cut from every address in it, and any
  /// `token=<value>` left over (an address written without its scheme) removed.
  public static func addresses(in text: String) -> String {
    var out = text
    for (pattern, template) in rules {
      out = pattern.stringByReplacingMatches(
        in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template)
    }
    return out
  }

  // Characters that end an address in a sentence: space, quotes, angle brackets and
  // the parentheses a reason is wrapped in.
  private static let rules: [(NSRegularExpression, String)] = [
    // scheme://host/path?query#fragment -> scheme://host/path
    (try! NSRegularExpression(pattern: #"([A-Za-z][A-Za-z0-9+.\-]*://[^\s?#"'<>()]*)[?#][^\s"'<>()]*"#), "$1"),
    // scheme://user:password@host -> scheme://host
    (try! NSRegularExpression(pattern: #"([A-Za-z][A-Za-z0-9+.\-]*://)[^\s/@"'<>()]*@"#), "$1"),
    // a token outside any address: ?token=..., &token=..., token=...
    (try! NSRegularExpression(pattern: #"[?&]?\btoken=[^&\s"'<>()]*"#, options: [.caseInsensitive]), ""),
  ]
}
