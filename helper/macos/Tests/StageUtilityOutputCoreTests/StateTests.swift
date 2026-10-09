import Foundation
import Testing
@testable import StageUtilityOutputCore

/// A fresh directory per test, removed afterwards.
func withTempDir<T>(_ body: (URL) throws -> T) rethrows -> T {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("suo-test-\(UUID().uuidString)", isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: dir) }
  return try body(dir)
}

@Suite struct PathsTests {
  let home = URL(fileURLWithPath: "/Users/someone")

  @Test func defaultsToTheInstallerAndTheUsersLibrary() {
    let p = HelperPaths.resolve(environment: [:], home: home)
    #expect(p.systemDir.path == "/Library/Application Support/StageUtility")
    #expect(p.userDir.path == "/Users/someone/Library/Application Support/StageUtilityOutput")
  }

  @Test func theOverrideReplacesBoth() {
    let p = HelperPaths.resolve(environment: ["STAGE_UTILITY_OUTPUT_STATE_DIR": "/tmp/x"], home: home)
    #expect(p.systemDir.path == "/tmp/x")
    #expect(p.userDir.path == "/tmp/x")
  }

  @Test func anEmptyOverrideIsIgnored() {
    let p = HelperPaths.resolve(environment: ["STAGE_UTILITY_OUTPUT_STATE_DIR": ""], home: home)
    #expect(p.userDir.path.hasSuffix("StageUtilityOutput"))
  }
}

@Suite struct MacIdentityTests {
  @Test func readsTheInstallersFiles() {
    withTempDir { dir in
      try! "  mac-id-1\n".write(to: dir.appendingPathComponent("device-id"), atomically: true, encoding: .utf8)
      try! "192.0.2.10:8788\n".write(to: dir.appendingPathComponent("server"), atomically: true, encoding: .utf8)
      try! "tok\n".write(to: dir.appendingPathComponent("token"), atomically: true, encoding: .utf8)
      let id = MacIdentity.load(paths: HelperPaths(systemDir: dir, userDir: dir))
      #expect(id.deviceId == "mac-id-1")
      #expect(id.source == .installer)
      #expect(id.server == "http://192.0.2.10:8788")
      #expect(id.installerToken == "tok")
    }
  }

  @Test func generatesAndKeepsAnIdWhenTheInstallerNeverRan() {
    withTempDir { dir in
      let system = dir.appendingPathComponent("system")
      let user = dir.appendingPathComponent("user")
      let paths = HelperPaths(systemDir: system, userDir: user)
      let first = MacIdentity.load(paths: paths, makeId: { "generated-1" })
      #expect(first.deviceId == "generated-1")
      #expect(first.source == .generated)
      #expect(first.server == nil)
      #expect(first.saveError == nil)
      // The second launch must not mint another one: that orphans every binding.
      let second = MacIdentity.load(paths: paths, makeId: { "generated-2" })
      #expect(second.deviceId == "generated-1")
      #expect(second.source == .generated)
    }
  }

  @Test func reportsAGeneratedIdThatCouldNotBeSaved() {
    withTempDir { dir in
      let blocker = dir.appendingPathComponent("file")
      try! "x".write(to: blocker, atomically: true, encoding: .utf8)
      // A directory cannot be made beneath a file.
      let paths = HelperPaths(systemDir: dir.appendingPathComponent("none"), userDir: blocker.appendingPathComponent("sub"))
      let id = MacIdentity.load(paths: paths, makeId: { "g" })
      #expect(id.deviceId == "g")
      #expect(id.saveError != nil)
    }
  }
}

@Suite struct OutputStateStoreTests {
  @Test func persistsARecordAcrossARestart() throws {
    try withTempDir { dir in
      var n = 0
      let store = OutputStateStore(directory: dir, makeToken: { n += 1; return "token-\(n)" })
      try store.ensure(key: "k1", defaultEnabled: true)
      try store.ensure(key: "k2", defaultEnabled: false)
      try store.setBoundTo("server-1", key: "k1")
      try store.setEnabled(true, key: "k2")

      let reopened = OutputStateStore(directory: dir, makeToken: { "must-not-be-used" })
      #expect(reopened.record(for: "k1") == OutputRecord(enabled: true, token: "token-1", boundTo: "server-1"))
      #expect(reopened.record(for: "k2") == OutputRecord(enabled: true, token: "token-2", boundTo: nil))
    }
  }

  /// The token is the output's identity to the server once claimed; a new one on
  /// every sighting would lock the screen out.
  @Test func theTokenIsMadeOnceAndEnsureNeverChangesAChoice() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir, makeToken: OutputStateStore.randomToken)
      let first = try store.ensure(key: "k", defaultEnabled: false)
      try store.setEnabled(true, key: "k")
      let again = try store.ensure(key: "k", defaultEnabled: false)
      #expect(again.token == first.token)
      #expect(again.enabled == true)
    }
  }

  @Test func randomTokensAre48HexCharactersAndDiffer() {
    let a = OutputStateStore.randomToken()
    #expect(a.count == 48)
    #expect(a.allSatisfy { $0.isHexDigit && !$0.isUppercase })
    #expect(a != OutputStateStore.randomToken())
  }

  /// The main display's default is applied once, at first sight, and stored.
  @Test func mainDisplayDefaultIsStoredNotRecomputed() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir)
      try store.ensure(key: "main", defaultEnabled: defaultEnabled(kind: .display, isMain: true))
      try store.ensure(key: "other", defaultEnabled: defaultEnabled(kind: .display, isMain: false))
      #expect(store.record(for: "main")?.enabled == false)
      #expect(store.record(for: "other")?.enabled == true)
      // The menu bar moves to the other display; neither choice flips.
      try store.ensure(key: "main", defaultEnabled: defaultEnabled(kind: .display, isMain: false))
      try store.ensure(key: "other", defaultEnabled: defaultEnabled(kind: .display, isMain: true))
      #expect(store.record(for: "main")?.enabled == false)
      #expect(store.record(for: "other")?.enabled == true)
    }
  }

  @Test func theFileIsReadableOnlyByItsOwner() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir)
      try store.ensure(key: "k", defaultEnabled: true)
      let attrs = try FileManager.default.attributesOfItem(atPath: store.file.path)
      #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }
  }

  /// An unreadable file holds tokens the server has pinned: move it aside, say so,
  /// never delete it.
  @Test func anUnreadableFileIsMovedAsideNotDeleted() throws {
    try withTempDir { dir in
      let file = dir.appendingPathComponent("outputs.json")
      try "{ not json".write(to: file, atomically: true, encoding: .utf8)
      let store = OutputStateStore(directory: dir)
      let aside = try #require(store.recoveredFrom)
      #expect(FileManager.default.fileExists(atPath: aside.path))
      #expect(try String(contentsOf: aside, encoding: .utf8) == "{ not json")
      #expect(store.record(for: "anything") == nil)
    }
  }

  @Test func savingToAnUnwritableDirectoryThrows() {
    withTempDir { dir in
      let blocker = dir.appendingPathComponent("file")
      try! "x".write(to: blocker, atomically: true, encoding: .utf8)
      let store = OutputStateStore(directory: blocker.appendingPathComponent("sub"))
      #expect(throws: (any Error).self) { try store.ensure(key: "k", defaultEnabled: true) }
    }
  }
}
