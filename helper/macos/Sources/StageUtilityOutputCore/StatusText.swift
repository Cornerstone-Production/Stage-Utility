import Foundation

/// The words in the helper's window. Decided here so they can be tested.
public enum StatusText {
  /// Everything the status line depends on.
  public struct Input: Equatable {
    public var enabled: Bool
    public var isMain: Bool
    /// Whether this output has a server address, found or from the `server` file.
    public var serverKnown: Bool
    /// The page is failing to load.
    public var unreachable: Bool
    /// The name of the screen this output is bound to, once known.
    public var boundScreenName: String?
    /// The output is showing a bound screen, whose name has not been read yet.
    public var showingBound: Bool
    public var fps: Double?
    /// The server does not recognise this output (a release in Screens, or a token
    /// it does not hold), so its health posts are paused.
    public var healthPaused: Bool
    /// What keeps a card output from sending: a mode its port refused, a port that
    /// is gone. It sends nothing, so it says so whatever the server is doing.
    public var portProblem: String?
    /// A card output's render-to-air latency over the last health window.
    public var latencyMs: Double?
    /// The output shows the latency test page (`--test-pattern latency`), not a
    /// server's screen.
    public var testPattern: Bool

    public init(
      enabled: Bool, isMain: Bool, serverKnown: Bool, unreachable: Bool = false,
      boundScreenName: String? = nil, showingBound: Bool = false, fps: Double? = nil,
      healthPaused: Bool = false, portProblem: String? = nil, latencyMs: Double? = nil, testPattern: Bool = false
    ) {
      self.enabled = enabled
      self.isMain = isMain
      self.serverKnown = serverKnown
      self.unreachable = unreachable
      self.boundScreenName = boundScreenName
      self.showingBound = showingBound
      self.fps = fps
      self.healthPaused = healthPaused
      self.portProblem = portProblem
      self.latencyMs = latencyMs
      self.testPattern = testPattern
    }
  }

  /// A DeckLink port with no modes to play: its connector is set as an input.
  public static let inputPortLine = "Set as an input in Desktop Video Setup"

  /// A card output that is sending frames but not the page: its line in place of the
  /// frame rate, which would read as healthy over black.
  public static func silenceLine(_ silence: CardWatch.Silence) -> String {
    switch silence {
    case .neverDrawn: return "No picture from the page. Sending black"
    case .stopped: return "No new picture from the page. Reloading it"
    }
  }

  public static func outputLine(_ i: Input) -> String {
    if !i.enabled {
      return i.isMain ? "The Mac's desktop. Off, so the menu bar stays here." : "Turned off here"
    }
    if let problem = i.portProblem {
      return i.boundScreenName.map { "\($0) · \(problem)" } ?? problem
    }
    if i.testPattern { return (["Latency test page"] + rates(i)).joined(separator: " · ") }
    if !i.serverKnown { return "Looking for Stage Utility" }
    if i.unreachable { return "Cannot reach the server. Retrying" }
    if i.boundScreenName != nil || i.showingBound {
      var parts = [i.boundScreenName ?? "Showing a screen"]
      if i.healthPaused {
        parts.append("not recognised by the server, health paused")
      } else {
        parts += rates(i)
      }
      return parts.joined(separator: " · ")
    }
    return "Waiting to be set up on the server"
  }

  /// "59.94 fps", and for a card output "20 ms behind the page".
  private static func rates(_ i: Input) -> [String] {
    guard let fps = i.fps, fps > 0 else { return [] }
    return [String(format: "%.2f fps", fps)] + (i.latencyMs.map { [String(format: "%.0f ms behind the page", $0)] } ?? [])
  }

  public enum Connection: Equatable {
    case searching
    /// No output is turned on, so nothing is looking.
    case noOutputs
    /// A `server` file names the server; nothing has been heard from it yet.
    case configured(address: String)
    case connected(name: String, address: String)
    case unreachable(address: String)
  }

  /// What the connection line reads from one output.
  public struct OutputFacts: Equatable {
    /// Turned on, so it has a window and is looking.
    public var active: Bool
    public var serverURL: String?
    /// The name a probe answer gave, once one has.
    public var serverName: String?
    /// The page has loaded at least once.
    public var loaded: Bool
    /// The page is failing to load.
    public var unreachable: Bool

    public init(active: Bool, serverURL: String? = nil, serverName: String? = nil, loaded: Bool = false, unreachable: Bool = false) {
      self.active = active
      self.serverURL = serverURL
      self.serverName = serverName
      self.loaded = loaded
      self.unreachable = unreachable
    }
  }

  /// The one line at the top of the window, from every output's facts.
  ///
  /// The worst news first: any turned-on output that cannot load its page says so,
  /// whatever the others are doing. Then a server that has been heard from or loaded
  /// from, then one only named, then nobody looking, then still searching.
  public static func connection(_ outputs: [OutputFacts]) -> Connection {
    let active = outputs.filter(\.active)
    if let bad = active.first(where: { $0.unreachable }), let url = bad.serverURL {
      return .unreachable(address: EnrollURL.displayAddress(url))
    }
    if let good = active.first(where: { $0.serverURL != nil && ($0.loaded || $0.serverName != nil) }), let url = good.serverURL {
      return .connected(name: good.serverName ?? "Stage Utility", address: EnrollURL.displayAddress(url))
    }
    if let any = active.first(where: { $0.serverURL != nil }), let url = any.serverURL {
      return .configured(address: EnrollURL.displayAddress(url))
    }
    return active.isEmpty ? .noOutputs : .searching
  }

  /// "Connected to Stage Utility at 192.0.2.10:8788" splits into these pieces so the
  /// window can set the name in bold and the address in monospace.
  public static func connectionLine(_ c: Connection) -> (prefix: String, name: String?, middle: String?, address: String?) {
    switch c {
    case .searching: return ("Looking for Stage Utility on the network", nil, nil, nil)
    case .noOutputs: return ("No outputs are turned on", nil, nil, nil)
    case .configured(let a): return ("Using the server file: ", nil, nil, a)
    case .connected(let name, let a): return ("Connected to ", name, " at ", a)
    case .unreachable(let a): return ("Cannot reach Stage Utility at ", nil, nil, a)
    }
  }
}
