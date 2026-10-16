import Foundation

/// The server's answer to a probe: `{stageUtility:"server",v:1,serverId,name,url}`
/// (`encodeReply` in kiosk-discovery.ts).
public struct DiscoveryReply: Equatable {
  public var serverId: String
  public var name: String
  public var url: String

  public init(serverId: String, name: String, url: String) {
    self.serverId = serverId
    self.name = name
    self.url = url
  }

  /// Parse a datagram, or nil when it is not a reply we can use. Never throws:
  /// anything on the LAN can send to the port a probe came from.
  ///
  /// The url must be http or https with a host and no path, because it is loaded in
  /// a browser (see `EnrollURL.Refusal.notAtTheRoot`). One longer than the server's 512 is refused rather than cut, since a
  /// cut address is a different address.
  public static func parse(_ data: Data) -> DiscoveryReply? {
    if data.count > Probe.maxDatagram { return nil }
    guard
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      obj["stageUtility"] as? String == "server",
      (obj["v"] as? NSNumber)?.intValue == 1,
      let serverId = nonEmpty(obj["serverId"], max: Probe.maxString),
      let url = nonEmpty(obj["url"], max: 512, truncate: false),
      let scheme = URL(string: url)?.scheme?.lowercased(), scheme == "http" || scheme == "https",
      EnrollURL.normalise(server: url) != nil
    else { return nil }
    return DiscoveryReply(serverId: serverId, name: nonEmpty(obj["name"], max: Probe.maxString) ?? serverId, url: url)
  }

  private static func nonEmpty(_ v: Any?, max: Int, truncate: Bool = true) -> String? {
    guard let s = v as? String, !s.isEmpty else { return nil }
    // UTF-16 units, as the server's JavaScript counts them.
    if s.utf16.count > max { return truncate ? s.clippedUTF16(to: max) : nil }
    return s
  }
}
