import Foundation

/// The one URL an output ever loads: `<server>/enroll?device=<id>&token=<token>`.
/// The server redirects it to the screen's display once claimed and shows the
/// holding screen until then.
public enum EnrollURL {
  /// A server address as typed into the `server` file or heard in a reply:
  /// surrounding whitespace dropped, "http://" assumed when there is no scheme,
  /// trailing slashes removed. Nil when nothing usable is left.
  public static func normalise(server: String) -> String? {
    var s = server.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return nil }
    if !s.contains("://") { s = "http://" + s }
    while s.hasSuffix("/") { s.removeLast() }
    guard let url = URL(string: s), let host = url.host, !host.isEmpty else { return nil }
    return s
  }

  public static func make(server: String, deviceId: String, token: String) -> URL? {
    guard let base = normalise(server: server) else { return nil }
    return URL(string: "\(base)/enroll?device=\(encode(deviceId))&token=\(encode(token))")
  }

  /// RFC 3986 unreserved characters pass; everything else is escaped. Stricter
  /// than URLComponents, which leaves "&" and "+" alone inside a query value.
  static func encode(_ s: String) -> String {
    var out = ""
    for byte in s.utf8 {
      let c = Character(UnicodeScalar(byte))
      if c.isASCII, c.isLetter || c.isNumber || c == "-" || c == "." || c == "_" || c == "~" {
        out.append(c)
      } else {
        out += String(format: "%%%02X", byte)
      }
    }
    return out
  }

  /// The server's address as a person reads it: `host:port`, no scheme.
  public static func displayAddress(_ server: String) -> String {
    guard let base = normalise(server: server), let url = URL(string: base), let host = url.host else { return server }
    if let port = url.port { return "\(host):\(port)" }
    return host
  }
}
