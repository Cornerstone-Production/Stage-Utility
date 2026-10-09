import Foundation

/// What an output is. A "decklink" output is a card port: a DeckLink or UltraStudio
/// port (`DeckLinkPort` in DeckLinkKit), or a virtual one (`VirtualCards`).
public enum OutputKind: String, Codable, Equatable {
  case display
  case decklink
}

/// One thing the helper can send a screen to, as the server is told about it.
public struct OutputDescriptor: Equatable {
  public var kind: OutputKind
  /// Stable across reboots and re-plugging: a display's UUID, or a DeckLink port's
  /// persistent id plus its sub-device index.
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

/// Card outputs with no card behind them, for `--virtual-sdi`: they run the whole
/// card path (a windowless page, the Metal conversion, the shim's scheduler on a
/// software clock, health, frame dumps) on a Mac with no DeckLink. They offer every
/// mode the server lists (`VideoModes.standard`). They exist only while the flag is
/// given.
public enum VirtualCards {
  public static let maxCount = 16

  /// "SDI 1 (virtual)" ... "SDI n (virtual)". The keys are stable, so a virtual
  /// output keeps its device id, and its binding, from one run to the next.
  public static func outputs(count: Int) -> [OutputDescriptor] {
    guard count > 0 else { return [] }
    return (1...min(count, maxCount)).map { n in
      let label = "SDI \(n) (virtual)"
      return OutputDescriptor(
        kind: .decklink, key: "virtual-sdi-\(n)", name: label, port: label,
        modes: VideoModes.offered(by: VideoModes.standard))
    }
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

/// What an output reports every ten seconds, in the units the server's health route
/// takes (`parseHealthReport` in output-health.ts).
public struct HealthSample: Equatable {
  /// Frames per second over the window.
  public var fps: Double
  /// The percent of the window's frames that repeated the one before because the
  /// page was late: 0 to 100.
  public var repeated: Double
  /// Frames dropped since the output opened. Cumulative: the server reads a count
  /// lower than the last as the output having been reopened, not as a drop.
  public var dropped: Int
  /// A card output's delay over the window, the median from a picture's content
  /// being drawn to its frame going out of the card (`FrameTiming.renderToAirMs`).
  /// Nil when nothing measured it: a display output, or no new picture went out.
  /// Shown in the helper's window and log; not sent to the server, whose health
  /// route keeps only the fields above.
  public var latencyMs: Double?

  public init(fps: Double, repeated: Double = 0, dropped: Int = 0, latencyMs: Double? = nil) {
    self.fps = fps
    self.repeated = repeated
    self.dropped = dropped
    self.latencyMs = latencyMs
  }
}
