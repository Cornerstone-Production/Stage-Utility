import Foundation

/// What the window's "Open at login" offers.
///
/// `install-macos.sh` starts the helper at every login with a system-wide
/// LaunchAgent (`HelperPaths.launchAgent`). Where it exists, a per-user login item
/// (`SMAppService.mainApp`) would start a second copy at login, which hands over to
/// the first and brings its window forward. So the window shows that the helper
/// starts at login, read-only, and a per-user item left from before the installer
/// is removed. A copy run by hand, on a Mac the installer never ran on, keeps the
/// switch.
public enum LoginItem {
  public enum Offer: Equatable {
    /// The installer's agent starts it: "Starts at login (installed)", no switch.
    case installed
    /// The switch, as the per-user login item stands.
    case userSwitch(on: Bool)
  }

  public struct Decision: Equatable {
    public var offer: Offer
    /// A per-user login item is registered beside the installer's agent: remove it.
    public var removeUserItem: Bool
  }

  public static func decide(agentInstalled: Bool, userItemEnabled: Bool) -> Decision {
    agentInstalled
      ? Decision(offer: .installed, removeUserItem: userItemEnabled)
      : Decision(offer: .userSwitch(on: userItemEnabled), removeUserItem: false)
  }
}
