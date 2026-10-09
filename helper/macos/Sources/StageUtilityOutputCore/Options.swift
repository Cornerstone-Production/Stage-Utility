import Foundation

/// Command-line flags. Parsed by hand: there are five and none is worth a
/// dependency.
public struct Options: Equatable {
  /// `--dump-frames <dir>`: write a PNG of every output every 5 s.
  public var dumpFramesDir: URL?
  /// `--show-window`: open the helper's window at launch (a menu bar app does not,
  /// otherwise, once it has been set up).
  public var showWindow = false
  /// `--list-outputs`: print each display's key, id and default, then exit.
  public var listOutputs = false
  /// `--discovery-port <n>`, else STAGE_KIOSK_PORT (the installer's variable), else 8789.
  /// The flag wins over the variable.
  public var discoveryPort: UInt16 = 8789
  /// `--log-stderr`: mirror the log to stderr.
  public var logToStderr = false

  public init() {}

  public static let dumpInterval: TimeInterval = 5

  public static func parse(_ args: [String], environment: [String: String]) -> (Options, [String]) {
    var o = Options()
    var problems: [String] = []
    if let p = environment["STAGE_KIOSK_PORT"], !p.isEmpty {
      if let n = UInt16(p), n > 0 { o.discoveryPort = n } else { problems.append("STAGE_KIOSK_PORT is not a port: \(p)") }
    }
    var i = 1
    func value(_ flag: String) -> String? {
      guard i + 1 < args.count else { problems.append("\(flag) needs a value"); return nil }
      i += 1
      return args[i]
    }
    while i < args.count {
      switch args[i] {
      case "--dump-frames":
        if let v = value("--dump-frames") { o.dumpFramesDir = URL(fileURLWithPath: v, isDirectory: true) }
      case "--discovery-port":
        if let v = value("--discovery-port") {
          if let n = UInt16(v), n > 0 { o.discoveryPort = n } else { problems.append("--discovery-port is not a port: \(v)") }
        }
      case "--show-window": o.showWindow = true
      case "--list-outputs": o.listOutputs = true
      case "--log-stderr": o.logToStderr = true
      default: problems.append("unknown argument: \(args[i])")
      }
      i += 1
    }
    return (o, problems)
  }
}
