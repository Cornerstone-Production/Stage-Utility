import Foundation

/// The one URL an output ever loads: `<server>/enroll?device=<id>&token=<token>`.
/// The server redirects it to the screen's display once claimed and shows the
/// holding screen until then.
public enum EnrollURL {
  /// Why an address cannot be used.
  public enum Refusal: Error, Equatable, CustomStringConvertible {
    case empty
    case noHost(String)
    /// The address has a path, a query or a fragment. Stage Utility is served from
    /// the root of its address: the redirect from /enroll to a screen, and every
    /// asset a screen loads, start with "/", so under a prefix they leave it. The
    /// helper therefore refuses a prefix rather than load a page that half works.
    case notAtTheRoot(given: String, use: String)

    public var description: String {
      switch self {
      case .empty: return "the server address is empty"
      case .noHost(let given): return "\"\(Redact.url(given))\" has no host"
      case .notAtTheRoot(let given, let use):
        return "\"\(Redact.url(given))\" has a path. Stage Utility has to be served from the root of its address, because its "
          + "redirects and assets start at \"/\"; use \"\(use)\""
      }
    }
  }

  /// A server address as typed into the `server` file or heard in a reply:
  /// surrounding whitespace dropped, "http://" assumed when there is no scheme,
  /// trailing slashes removed. Refused, with the reason, when nothing usable is
  /// left or it carries a path.
  public static func check(server: String) -> Result<String, Refusal> {
    let given = server.trimmingCharacters(in: .whitespacesAndNewlines)
    if given.isEmpty { return .failure(.empty) }
    var s = given
    if !s.contains("://") { s = "http://" + s }
    while s.hasSuffix("/") { s.removeLast() }
    guard let url = URL(string: s), let host = url.host, !host.isEmpty else { return .failure(.noHost(given)) }
    if !url.path.isEmpty || url.query != nil || url.fragment != nil {
      let port = url.port.map { ":\($0)" } ?? ""
      return .failure(.notAtTheRoot(given: given, use: "\(url.scheme ?? "http")://\(host)\(port)"))
    }
    return .success(s)
  }

  /// `check`, without the reason: nil when the address cannot be used.
  public static func normalise(server: String) -> String? {
    if case .success(let s) = check(server: server) { return s }
    return nil
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

  /// The host of a usable server address, for sending it a probe.
  public static func host(of server: String) -> String? {
    normalise(server: server).flatMap { URL(string: $0)?.host }
  }

  /// The server's address as a person reads it: `host:port`, no scheme.
  public static func displayAddress(_ server: String) -> String {
    guard let base = normalise(server: server), let url = URL(string: base), let host = url.host else { return server }
    if let port = url.port { return "\(host):\(port)" }
    return host
  }
}
