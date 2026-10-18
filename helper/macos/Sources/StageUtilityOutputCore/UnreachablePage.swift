import Foundation

/// What an output shows when its page did not load: the helper's own screen, never
/// Chromium's error page.
///
/// Chromium's error page prints the whole address it failed to load, and the address
/// an output loads is `<server>/enroll?device=<id>&token=<token>` (`EnrollURL`): the
/// token, on air. This page names the server's host and port and nothing else of the
/// address. The browser host hides Chromium's page until this one has committed
/// (CEFHost/cef_host_mac.mm, `Blank`).
public enum UnreachablePage {
  /// Chromium's net::ERR_ADDRESS_UNREACHABLE (net_error_list.h): what a connect that
  /// failed with EHOSTUNREACH ("No route to host") becomes, and so what a load
  /// macOS's Local Network privacy refused looks like.
  public static let addressUnreachable = -109

  /// What macOS's Local Network privacy has to do with a failure, as far as the
  /// helper can tell from the rest of the app.
  public struct Evidence: Equatable {
    /// The server answered this output's discovery probe since the loads began
    /// failing: it is up, and the app reaches it.
    public var serverAnswered: Bool
    /// Every broadcast probe failed with "No route to host": the app's own Local
    /// Network access is likely off (`LocalNetworkAccess`).
    public var broadcastsBlocked: Bool

    public init(serverAnswered: Bool, broadcastsBlocked: Bool) {
      self.serverAnswered = serverAnswered
      self.broadcastsBlocked = broadcastsBlocked
    }

    public static let none = Evidence(serverAnswered: false, broadcastsBlocked: false)

    /// From when the server last answered and when the loads began failing. An
    /// answer from before the failures could be from a server switched off since.
    public init(answeredAt: Date?, failingSince: Date, broadcastsBlocked: Bool) {
      self.init(serverAnswered: (answeredAt ?? .distantPast) > failingSince, broadcastsBlocked: broadcastsBlocked)
    }
  }

  public struct Content: Equatable {
    /// "Can't reach 192.0.2.10:8788".
    public var headline: String
    /// Whether to say where Local Network access is turned on.
    public var localNetwork: Bool

    /// The end of the failure's log line: what the output shows instead.
    public var logNote: String {
      "; the output shows \"\(headline)\"" + (localNetwork ? " and where to turn on Local Network access" : "")
    }
  }

  public static let localNetworkLine =
    "Local Network access for Stage Utility Output may be off. Turn it on on this Mac in System Settings > Privacy & Security > Local Network."
  public static let retryingLine = "Trying again."

  /// The screen for a load of `target` that failed with Chromium's `netError`.
  ///
  /// The Local Network line is shown only for an unreachable address on the local
  /// network when something else says the server is not simply off: it answered
  /// discovery, or the app's own broadcasts are refused. A server switched off on
  /// the same subnet gives the same error, and then neither holds.
  public static func content(target: URL, netError: Int, evidence: Evidence) -> Content {
    let host = target.host ?? ""
    let localNetwork =
      netError == addressUnreachable && isLocalNetworkHost(host)
      && (evidence.serverAnswered || evidence.broadcastsBlocked)
    return Content(headline: "Can't reach \(serverLabel(target))", localNetwork: localNetwork)
  }

  /// The lines on the screen, in order.
  public static func lines(_ content: Content) -> [String] {
    [content.headline] + (content.localNetwork ? [localNetworkLine] : []) + [retryingLine]
  }

  /// The page itself, as an address the browser loads: a `data:` URL, so it needs
  /// no server and no file.
  public static func url(_ content: Content) -> URL {
    let html = Data(html(content).utf8).base64EncodedString()
    return URL(string: "data:text/html;charset=utf-8;base64,\(html)")!
  }

  public static func html(_ content: Content) -> String {
    let detail = content.localNetwork ? "<p class=\"hint\">\(escape(localNetworkLine))</p>" : ""
    return """
      <!doctype html><html><head><meta charset="utf-8"><title>\(escape(content.headline))</title><style>
      html,body{margin:0;height:100%;background:#0a0a0a;color:#ededf0;font-family:-apple-system,system-ui,sans-serif}
      body{display:flex;align-items:center;justify-content:center;text-align:center}
      main{max-width:60vw}
      h1{font-size:5vh;font-weight:700;margin:0 0 2vh}
      p{font-size:2.2vh;color:#9a9aa3;margin:1vh 0}
      p.hint{color:#ffca16}
      </style></head><body><main><h1>\(escape(content.headline))</h1>\(detail)<p>\(escape(retryingLine))</p></main></body></html>
      """
  }

  /// The server as the screen names it: its host, and its port when the address has
  /// one. Never its path or query.
  public static func serverLabel(_ target: URL) -> String {
    guard let host = target.host, !host.isEmpty else { return "the server" }
    let shown = host.contains(":") ? "[\(host)]" : host
    return target.port.map { "\(shown):\($0)" } ?? shown
  }

  /// Whether macOS's Local Network privacy covers connecting to `host`: a private or
  /// link-local IPv4 address, a unique-local or link-local IPv6 one, or a `.local`
  /// name. Loopback is exempt from it, and a name that DNS resolves is not judged.
  public static func isLocalNetworkHost(_ host: String) -> Bool {
    let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if h.hasSuffix(".local") || h.hasSuffix(".local.") { return true }
    var v4 = in_addr()
    if inet_pton(AF_INET, h, &v4) == 1 {
      let a = UInt32(bigEndian: v4.s_addr)
      let b0 = a >> 24, b1 = (a >> 16) & 0xff
      return b0 == 10 || (b0 == 172 && (16...31).contains(b1)) || (b0 == 192 && b1 == 168)
        || (b0 == 169 && b1 == 254)
    }
    var v6 = in6_addr()
    if inet_pton(AF_INET6, h, &v6) == 1 {
      let bytes = withUnsafeBytes(of: v6) { Array($0) }
      return (bytes[0] & 0xfe) == 0xfc || (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80)
    }
    return false
  }

  private static func escape(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
  }
}
