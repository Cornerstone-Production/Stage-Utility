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
    /// The server told this output's health posts to stop: it has no screen set up
    /// for it (a release in Screens), or refused its token.
    public var healthPause: HealthGate.Pause?

    public init(
      enabled: Bool, isMain: Bool, serverKnown: Bool, unreachable: Bool = false,
      boundScreenName: String? = nil, showingBound: Bool = false, fps: Double? = nil,
      healthPause: HealthGate.Pause? = nil
    ) {
      self.enabled = enabled
      self.isMain = isMain
      self.serverKnown = serverKnown
      self.unreachable = unreachable
      self.boundScreenName = boundScreenName
      self.showingBound = showingBound
      self.fps = fps
      self.healthPause = healthPause
    }
  }

  public static func outputLine(_ i: Input) -> String {
    if !i.enabled {
      return i.isMain ? "The Mac's desktop. Off, so the menu bar stays here." : "Turned off here"
    }
    if !i.serverKnown { return "Looking for Stage Utility" }
    if i.unreachable { return "Cannot reach the server. Retrying" }
    if i.boundScreenName != nil || i.showingBound {
      var parts = [i.boundScreenName ?? "Showing a screen"]
      if let pause = i.healthPause {
        parts.append(pause == .unknownDevice ? "not set up on the server, health paused" : "token refused, health paused")
      } else if let fps = i.fps, fps > 0 {
        parts.append(String(format: "%.2f fps", fps))
      }
      return parts.joined(separator: " · ")
    }
    return "Waiting to be set up on the server"
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
