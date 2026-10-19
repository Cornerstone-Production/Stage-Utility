import Foundation

/// What this copy of the helper tells the updater that installed it.
///
/// The updater (`install-macos.sh --check-update`, a root LaunchDaemon) swaps the
/// app and restarts it through launchd, and then has to know the new one really
/// works before it deletes the old one: a process that is running is not enough,
/// because a helper whose Chromium did not start runs, says so in its window, and
/// shows nothing. So the helper writes this file at launch and whenever one of these
/// facts changes, and the updater reads it from the logged-in user's folder.
///
/// It also says which server the helper is talking to, so the updater asks the
/// server this Mac actually follows, which discovery may have moved since install.
///
/// Holds nothing secret. Written `0600` like everything in the folder (root reads
/// it regardless).
public struct HelperStatus: Codable, Equatable {
  public enum Chromium: String, Codable {
    case started
    case failed
  }

  /// `CFBundleShortVersionString`: what the updater compares with what it installed.
  public var version: String
  /// This process. The updater matches it against launchd's pid for the agent, so a
  /// file left behind by the copy it just stopped is never read as the new one.
  public var pid: Int32
  public var chromium: Chromium
  /// Why Chromium did not start, when it did not.
  public var chromiumProblem: String?
  /// The root of the server this helper's outputs are loading from (`http://host:port`),
  /// or nil before any server has answered.
  public var server: String?
  /// Every broadcast probe is refused, which is how a refused Local Network
  /// permission shows (`LocalNetworkAccess`). The updater reports it after an update,
  /// because the helper itself can then not reach the server to say so.
  public var localNetworkRefused: Bool

  public init(version: String, pid: Int32, chromium: Chromium, chromiumProblem: String? = nil, server: String? = nil, localNetworkRefused: Bool = false) {
    self.version = version
    self.pid = pid
    self.chromium = chromium
    self.chromiumProblem = chromiumProblem
    self.server = server
    self.localNetworkRefused = localNetworkRefused
  }

  /// The file's name in the helper's own folder. `HELPER_STATUS_NAME` in
  /// scripts/kiosk/install-macos.sh (`InstallerContractTests`).
  public static let fileName = "helper-status.json"

  /// The server root an output's address belongs to, without any path, query or
  /// fragment: the only part the updater needs, and the address carries a token.
  public static func serverRoot(of url: String) -> String? {
    guard let c = URLComponents(string: url), let scheme = c.scheme, scheme == "http" || scheme == "https", let host = c.host, !host.isEmpty
    else { return nil }
    var root = URLComponents()
    root.scheme = scheme
    root.host = host
    root.port = c.port
    return root.string
  }

  /// One line of JSON with sorted keys, so the same facts are the same bytes and a
  /// write can be skipped when nothing changed.
  public func encoded() -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // A struct of strings, ints and bools: encoding cannot fail.
    return (try? encoder.encode(self)) ?? Data()
  }
}
