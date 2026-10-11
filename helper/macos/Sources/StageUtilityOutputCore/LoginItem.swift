import Foundation

/// What the window's "Open at login" offers.
///
/// A system-wide LaunchAgent (`HelperPaths.launchAgent`) starts the helper at every
/// login. Where that file exists, a per-user login item (`SMAppService.mainApp`)
/// would start a second copy at login, which hands over to the first and brings its
/// window forward. So the window shows that the helper starts at login, read-only,
/// and a per-user item registered beside the agent is removed. Where the file does
/// not exist, the window keeps the switch.
///
/// A copy run with `STAGE_UTILITY_OUTPUT_STATE_DIR` (tests and development) never
/// touches the login item at all: the item is per user and per app, not per state
/// folder, so one registered from a test outlives it, starts the helper at the next
/// login with the real state, and holds its DeckLink ports.
public enum LoginItem {
  public enum Offer: Equatable {
    /// The LaunchAgent starts it: "Starts at login (installed)", no switch.
    case installed
    /// The switch, as the per-user login item stands.
    case userSwitch(on: Bool)
    /// A copy with its own state folder: no switch, and the item is left alone.
    case unavailable
  }

  public struct Decision: Equatable {
    public var offer: Offer
    /// A per-user login item is registered beside the LaunchAgent: remove it.
    public var removeUserItem: Bool
  }

  public static func decide(agentInstalled: Bool, userItemEnabled: Bool) -> Decision {
    agentInstalled
      ? Decision(offer: .installed, removeUserItem: userItemEnabled)
      : Decision(offer: .userSwitch(on: userItemEnabled), removeUserItem: false)
  }
}

/// The per-user login item: `SMAppService.mainApp` in the app.
public protocol LoginItemService: AnyObject {
  var isEnabled: Bool { get }
  func register() throws
  func unregister() throws
}

/// Decides what "Open at login" offers and does what the operator asks, through a
/// `LoginItemService` it only makes when this copy may touch the login item at all.
public final class LoginItemSwitch {
  public private(set) var offer: LoginItem.Offer
  /// Why the last change failed, for the window; nil once one works.
  public private(set) var error: String?
  /// What is worth a log line, from the last call: the window says the rest.
  public private(set) var logLine: (isError: Bool, text: String)?
  private let service: LoginItemService?

  /// For a copy with its own state folder (`HelperPaths.isOverridden`) the service
  /// is never made. Otherwise the LaunchAgent is looked for at
  /// `paths.launchAgent`.
  public init(paths: HelperPaths, makeService: () -> LoginItemService) {
    let agent = paths.launchAgent.path
    guard !paths.isOverridden else {
      service = nil
      offer = .unavailable
      logLine = (false, "open at login: left alone, because this copy runs with its own state folder")
      return
    }
    let service = makeService()
    self.service = service
    let decision = LoginItem.decide(
      agentInstalled: FileManager.default.fileExists(atPath: agent), userItemEnabled: service.isEnabled)
    offer = decision.offer
    guard decision.removeUserItem else { return }
    do {
      try service.unregister()
      logLine = (false, "open at login: removed this app's own login item; \(agent) already starts it at every login")
    } catch {
      self.error = "This app's own login item could not be removed: \(error.localizedDescription)"
      logLine = (true, "could not remove this app's own login item beside \(agent), so two copies may start at login: \(error.localizedDescription)")
    }
  }

  /// The switch was turned. Nothing happens unless the switch is offered.
  public func set(_ on: Bool) {
    guard case .userSwitch = offer, let service else {
      logLine = nil
      return
    }
    do {
      if on { try service.register() } else { try service.unregister() }
      error = nil
      logLine = (false, "open at login: \(on ? "on" : "off")")
    } catch {
      self.error = error.localizedDescription
      logLine = (true, "could not turn open at login \(on ? "on" : "off"): \(error.localizedDescription)")
    }
    offer = .userSwitch(on: service.isEnabled)
  }
}
