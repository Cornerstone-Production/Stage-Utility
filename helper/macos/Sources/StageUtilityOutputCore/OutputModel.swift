import Foundation

/// What an output is. "decklink" is step 3; it is here so the wire format and the
/// sink protocol do not change when it lands.
public enum OutputKind: String, Codable, Equatable {
  case display
  case decklink
}

/// One thing the helper can send a screen to, as the server is told about it.
public struct OutputDescriptor: Equatable {
  public var kind: OutputKind
  /// Stable across reboots and re-plugging: a display's UUID, later a DeckLink
  /// port's persistent id plus its sub-device index.
  public var key: String
  /// What the operator reads: "HDMI · LG 27UL", "Display 2 · LG 27UL".
  public var name: String
  /// The short label for where it plugs in: "HDMI", "Display 2", "SDI 1".
  public var port: String
  /// Output modes a port offers ("1080p59.94"). Absent for a display.
  public var modes: [String]?
  /// The display with the menu bar. Meaningless for any other kind.
  public var isMain: Bool

  public init(kind: OutputKind, key: String, name: String, port: String, modes: [String]? = nil, isMain: Bool = false) {
    self.kind = kind
    self.key = key
    self.name = name
    self.port = port
    self.modes = modes
    self.isMain = isMain
  }
}

public enum OutputNaming {
  /// The port label and the full name for a display.
  ///
  /// The prefix is the connector when it is known and "Display N" when it is not;
  /// macOS reports a connector for the built-in panel and for nothing else this
  /// helper can read without private IOKit paths. N counts from 1 in the order
  /// macOS lists the screens.
  public static func display(connector: String?, index: Int, localizedName: String) -> (port: String, name: String) {
    let port = (connector?.isEmpty == false) ? connector! : "Display \(index)"
    let name = localizedName.isEmpty ? port : "\(port) · \(localizedName)"
    return (port, name)
  }
}

/// Whether an output starts switched on, before the operator has chosen.
///
/// The Mac's main display is the one with the menu bar, and covering it takes the
/// Mac's desktop away from whoever is standing at it. Everything else is on, so a
/// plugged-in monitor is simply a screen. A headless Mac turns the main display on
/// in the window.
public func defaultEnabled(kind: OutputKind, isMain: Bool) -> Bool {
  !(kind == .display && isMain)
}

/// What an output reports every ten seconds.
public struct HealthSample: Equatable {
  public var fps: Double
  public var repeated: Int
  public var dropped: Int

  public init(fps: Double, repeated: Int = 0, dropped: Int = 0) {
    self.fps = fps
    self.repeated = repeated
    self.dropped = dropped
  }
}

/// Where an output's pictures go. A display is a full-screen window; step 3 adds a
/// DeckLink port, which is a web view off every display whose frames are written
/// to a card. Nothing above this protocol knows which it is talking to.
public protocol OutputSink: AnyObject {
  var descriptor: OutputDescriptor { get }
  /// Load, or reload, the screen at this URL.
  func show(url: URL)
  /// Stop drawing and release whatever the output holds.
  func stop()
  /// Counters since the last call, as the health post reports them.
  func takeHealthSample() -> HealthSample
  /// Write what the output is showing to `file` as a PNG. `completion` gets nil on
  /// success, else why not.
  func writeSnapshot(to file: URL, completion: @escaping (String?) -> Void)
}
