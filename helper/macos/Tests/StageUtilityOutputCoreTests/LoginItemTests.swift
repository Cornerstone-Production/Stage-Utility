import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct LoginItemTests {
  /// The installer's agent starts the helper: no switch, so no second, per-user
  /// login item can be made.
  @Test func anInstalledAgentIsShownNotOffered() {
    #expect(LoginItem.decide(agentInstalled: true, userItemEnabled: false) == .init(offer: .installed, removeUserItem: false))
  }

  /// A per-user item from before the installer would start a second copy at login.
  @Test func aUserItemBesideTheAgentIsRemoved() {
    #expect(LoginItem.decide(agentInstalled: true, userItemEnabled: true) == .init(offer: .installed, removeUserItem: true))
  }

  /// A copy run by hand keeps the switch, showing the item as it stands.
  @Test func aHandRunCopyKeepsTheSwitch() {
    #expect(LoginItem.decide(agentInstalled: false, userItemEnabled: false) == .init(offer: .userSwitch(on: false), removeUserItem: false))
    #expect(LoginItem.decide(agentInstalled: false, userItemEnabled: true) == .init(offer: .userSwitch(on: true), removeUserItem: false))
  }
}
