import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct LoginItemTests {
  /// The LaunchAgent starts the helper: no switch, so no second, per-user
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

/// A login item that records what was asked of it.
final class RecordingLoginItem: LoginItemService {
  var enabled: Bool
  var calls: [String] = []
  init(enabled: Bool = false) { self.enabled = enabled }
  var isEnabled: Bool {
    calls.append("status")
    return enabled
  }
  func register() throws {
    calls.append("register")
    enabled = true
  }
  func unregister() throws {
    calls.append("unregister")
    enabled = false
  }
}

@Suite struct LoginItemSwitchTests {
  /// Folders where the LaunchAgent is, or is not: this test file stands in
  /// for an agent that exists.
  func paths(overridden: Bool, agent: Bool) -> HelperPaths {
    let dir = URL(fileURLWithPath: "/nonexistent-state", isDirectory: true)
    var p = HelperPaths(
      systemDir: dir, userDir: dir,
      launchAgent: agent ? URL(fileURLWithPath: #filePath) : dir.appendingPathComponent("no-agent.plist"))
    p.isOverridden = overridden
    return p
  }

  /// A copy with its own state folder never touches the per-user login item: it
  /// outlives the folder, and at the next login starts the helper with the real
  /// state, which then holds the DeckLink ports. Not even its state is read, and the
  /// window offers no switch.
  @Test func aCopyWithItsOwnStateFolderNeverTouchesTheLoginItem() {
    let item = RecordingLoginItem(enabled: true)
    var made = 0
    let login = LoginItemSwitch(paths: paths(overridden: true, agent: true), makeService: {
      made += 1
      return item
    })
    login.set(true)
    login.set(false)
    #expect(made == 0)
    #expect(item.calls.isEmpty)
    #expect(login.offer == .unavailable)
    #expect(login.error == nil)
  }

  /// The real folders: the switch registers and unregisters, and reads back.
  @Test func theRealFoldersHaveTheSwitch() {
    let item = RecordingLoginItem()
    let login = LoginItemSwitch(paths: paths(overridden: false, agent: false), makeService: { item })
    #expect(login.offer == .userSwitch(on: false))
    login.set(true)
    #expect(login.offer == .userSwitch(on: true))
    #expect(item.calls == ["status", "register", "status"])
  }

  /// Beside the LaunchAgent a user item registered earlier is removed, and the
  /// switch is not offered.
  @Test func besideTheAgentAUserItemIsRemoved() {
    let item = RecordingLoginItem(enabled: true)
    let login = LoginItemSwitch(paths: paths(overridden: false, agent: true), makeService: { item })
    login.set(true)
    #expect(login.offer == .installed)
    #expect(item.calls == ["status", "unregister"])
  }

  @Test func theStateFolderOverrideIsKnownToBeOne() {
    let home = URL(fileURLWithPath: "/Users/x")
    #expect(HelperPaths.resolve(environment: ["STAGE_UTILITY_OUTPUT_STATE_DIR": "/tmp/s"], home: home).isOverridden)
    #expect(!HelperPaths.resolve(environment: [:], home: home).isOverridden)
    #expect(!HelperPaths.resolve(environment: ["STAGE_UTILITY_OUTPUT_STATE_DIR": ""], home: home).isOverridden)
  }
}
