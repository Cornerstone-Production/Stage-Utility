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
    #expect(p.launchAgent.path == "/Library/LaunchAgents/com.stageutility.output.plist")
  }

  @Test func theOverrideReplacesBoth() {
    let p = HelperPaths.resolve(environment: ["STAGE_UTILITY_OUTPUT_STATE_DIR": "/tmp/x"], home: home)
    #expect(p.systemDir.path == "/tmp/x")
    #expect(p.userDir.path == "/tmp/x")
    #expect(p.launchAgent.path == "/tmp/x/LaunchAgents/com.stageutility.output.plist")
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

  /// A prefixed server file would load a page that half works. It is ignored, so
  /// discovery runs, and the reason is kept for the window.
  @Test func aServerFileWithAPathIsIgnoredAndSaysWhy() {
    withTempDir { dir in
      try! "mac-id-1".write(to: dir.appendingPathComponent("device-id"), atomically: true, encoding: .utf8)
      try! "192.0.2.10:8788/su".write(to: dir.appendingPathComponent("server"), atomically: true, encoding: .utf8)
      let id = MacIdentity.load(paths: HelperPaths(systemDir: dir, userDir: dir))
      #expect(id.server == nil)
      #expect(id.serverProblem?.contains("has a path") == true)
      #expect(id.serverProblem?.contains(#"use "http://192.0.2.10:8788""#) == true)
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

  /// With the state-dir override both folders are one, and a generated id must not
  /// read as the installer's on the next launch.
  @Test func aGeneratedIdStaysGeneratedWhenBothFoldersAreOne() {
    withTempDir { dir in
      let paths = HelperPaths(systemDir: dir, userDir: dir)
      _ = MacIdentity.load(paths: paths, makeId: { "g1" })
      let again = MacIdentity.load(paths: paths, makeId: { "g2" })
      #expect(again.deviceId == "g1")
      #expect(again.source == .generated)
    }
  }

  /// An id that exists and cannot be read is not a missing one: a new id saved over it
  /// would orphan every binding made under the old.
  @Test func anUnreadableGeneratedIdIsNotReplaced() throws {
    try withTempDir { dir in
      let file = dir.appendingPathComponent(MacIdentity.generatedFileName)
      try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
      let id = MacIdentity.load(paths: HelperPaths(systemDir: dir, userDir: dir), makeId: { "temporary" })
      #expect(id.deviceId == "temporary")
      #expect(id.saveError?.contains("could not be read") == true)
      var isDirectory: ObjCBool = false
      #expect(FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory) && isDirectory.boolValue)
    }
  }

  /// `--list-outputs` reads. It must not make an id, a folder or a token.
  @Test func readingTheStoredStateWritesNothing() throws {
    try withTempDir { dir in
      let paths = HelperPaths(systemDir: dir.appendingPathComponent("system"), userDir: dir.appendingPathComponent("user"))
      #expect(MacIdentity.stored(paths: paths) == nil)
      let store = OutputStateStore(directory: paths.userDir)
      let lines = OutputListing.lines(
        identity: nil, displays: [OutputDescriptor(kind: .display, key: "k", name: "Display 1", port: "Display 1", isMain: true)],
        record: { store.record(for: $0) })
      #expect(lines[0].contains("none yet"))
      #expect(lines[1] == "k\t-\tDisplay 1\tdefault off (not stored yet)")
      let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
      #expect(names == [])
    }
  }

  @Test func listsWhatIsStoredBeforeWhatIsDefault() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir)
      try store.ensure(key: "k", defaultEnabled: true)
      try store.setEnabled(false, key: "k")
      let identity = MacIdentity(deviceId: "mac", source: .installer, server: nil, installerToken: nil)
      let lines = OutputListing.lines(
        identity: identity, displays: [OutputDescriptor(kind: .display, key: "k", name: "Display 2", port: "Display 2")],
        record: { store.record(for: $0) })
      #expect(lines[0] == "mac device id: mac (installer)")
      #expect(lines[1] == "k\tmac.k\tDisplay 2\toff (stored)")
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

  /// A card output's format, as its screen last set it, survives a restart so the
  /// port opens in it; the default is no entry at all, and a file from before the
  /// field reads as the default.
  @Test func aCardOutputsFormatIsKeptAcrossARestart() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir, makeToken: { "t" })
      try store.ensure(key: "sdi", defaultEnabled: true)
      try store.ensure(key: "other", defaultEnabled: true)
      try store.setVideoMode(" 720p59.94\n", key: "sdi")
      try store.setVideoMode("", key: "other")
      let reopened = OutputStateStore(directory: dir, makeToken: { "must-not-be-used" })
      #expect(reopened.record(for: "sdi")?.videoMode == "720p59.94")
      #expect(reopened.record(for: "other")?.videoMode == nil)
      let text = try String(contentsOf: dir.appendingPathComponent("outputs.json"), encoding: .utf8)
      #expect(text.components(separatedBy: "videoMode").count == 2, "\(text)")  // the one set, only
      try reopened.setVideoMode(nil, key: "sdi")
      #expect(OutputStateStore(directory: dir).record(for: "sdi")?.videoMode == nil)
    }
    try withTempDir { dir in
      try Data(#"{"outputs":{"sdi":{"enabled":true,"token":"t"}}}"#.utf8).write(
        to: dir.appendingPathComponent("outputs.json"))
      let old = OutputStateStore(directory: dir)
      #expect(old.readProblem == nil)
      #expect(old.record(for: "sdi") == OutputRecord(enabled: true, token: "t"))
    }
  }

  /// The helper decides whether to open its window "on a first run" after it has
  /// recorded its outputs, which is what makes the file. The answer has to be the one
  /// from before: `hasFile` is true by then on every Mac, and the window never opened.
  @Test func aFirstRunStaysAFirstRunOnceTheOutputsAreRecorded() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir)
      #expect(!store.existedAtLoad)
      try store.ensure(key: "k", defaultEnabled: true)
      #expect(store.hasFile)
      #expect(!store.existedAtLoad)
      #expect(OutputStateStore(directory: dir).existedAtLoad)
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

  /// An unreadable file holds tokens the server has pinned. Fresh tokens saved over
  /// it would lock every claimed output out, so it is left exactly as it is.
  @Test func aFileThatIsNotWhatWeWroteIsNeverWrittenOver() throws {
    try withTempDir { dir in
      let file = dir.appendingPathComponent("outputs.json")
      try "{ not json".write(to: file, atomically: true, encoding: .utf8)
      let store = OutputStateStore(directory: dir)
      #expect(store.readProblem?.contains("is not what the helper wrote") == true)
      #expect(throws: OutputStateStore.Unreadable.self) { try store.ensure(key: "k", defaultEnabled: true) }
      #expect(throws: OutputStateStore.Unreadable.self) { try store.setEnabled(false, key: "k") }
      #expect(try String(contentsOf: file, encoding: .utf8) == "{ not json")
      // Nothing was moved aside either: the person who fixes it finds it where it was.
      let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
      #expect(names == ["outputs.json"])
    }
  }

  /// "Cannot be read" and "is not there" are different answers: the second is a first
  /// run and is written; the first must never be.
  @Test func aFileThatCannotBeReadIsNotAFirstRun() throws {
    try withTempDir { dir in
      // A directory where the file should be: present, and unreadable as a file.
      try FileManager.default.createDirectory(at: dir.appendingPathComponent("outputs.json"), withIntermediateDirectories: false)
      let store = OutputStateStore(directory: dir)
      #expect(store.readProblem?.contains("could not be read") == true)
      #expect(throws: OutputStateStore.Unreadable.self) { try store.ensure(key: "k", defaultEnabled: true) }
    }
  }

  @Test func aMissingFileIsAFirstRunAndIsWritten() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir)
      #expect(store.readProblem == nil)
      try store.ensure(key: "k", defaultEnabled: true)
      #expect(FileManager.default.fileExists(atPath: store.file.path))
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

  /// `--new-token`: a new secret, saved, and nothing else about the output changes.
  /// Not its id, so the server still knows which screen it was; not `boundTo`, so no
  /// other server on the network is handed the new secret.
  @Test func aNewTokenReplacesOnlyTheToken() throws {
    try withTempDir { dir in
      var n = 0
      let store = OutputStateStore(directory: dir, makeToken: { n += 1; return "token-\(n)" })
      try store.ensure(key: "sdi", defaultEnabled: true)
      try store.setBoundTo("server-1", key: "sdi")
      try store.setVideoMode("720p59.94", key: "sdi")
      try store.ensure(key: "other", defaultEnabled: true)
      let before = try #require(store.record(for: "sdi"))

      #expect(try store.newToken(key: "sdi") == "token-3")
      var expected = before
      expected.token = "token-3"
      #expect(store.record(for: "sdi") == expected)
      #expect(store.record(for: "other")?.token == "token-2")
      // Saved: a restart reads the new one.
      #expect(OutputStateStore(directory: dir).record(for: "sdi") == expected)
      #expect(try store.newToken(key: "missing") == nil)
      #expect(store.record(for: "missing") == nil)
    }
  }

  /// The output that took over the Mac's Chrome kiosk keeps going by the Mac's id,
  /// with a secret of its own from now on.
  @Test func aNewTokenForTheKioskOutputKeepsItsIdentity() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir, makeToken: { "fresh" })
      var mac = MacIdentity(deviceId: "mac", source: .installer, server: nil, installerToken: "installer-token")
      mac.migratedFromKiosk = true
      let main = OutputDescriptor(kind: .display, key: "main", name: "Built-in", port: "Built-in", isMain: true)
      #expect(try store.ensure(main, mac: mac).token == "installer-token")
      _ = try store.newToken(key: "main")
      #expect(store.record(for: "main")?.kioskIdentity == true)
      #expect(store.record(for: "main")?.token == "fresh")
      #expect(store.record(for: "main")?.deviceId(mac: "mac", key: "main") == "mac")
    }
  }
}

@Suite struct TokenRotationTests {
  @Test func saysWhatIsLeftToDoAndNeverPrintsTheSecret() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir, makeToken: OutputStateStore.randomToken)
      let old = try store.ensure(key: "decklink-ab-0", defaultEnabled: true).token
      let result = TokenRotation.run(store: store, key: "decklink-ab-0", macDeviceId: "mac-1")
      #expect(result.succeeded)
      let new = try #require(store.record(for: "decklink-ab-0")?.token)
      #expect(new != old)
      #expect(OutputStateStore(directory: dir).record(for: "decklink-ab-0")?.token == new)
      let text = result.lines.joined(separator: "\n")
      #expect(!text.contains(new) && !text.contains(old))
      #expect(text.contains("mac-1.decklink-ab-0"))
      #expect(text.contains("Release"))
      #expect(text.contains("Not set up yet"))
    }
  }

  @Test func anUnknownOutputChangesNothing() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir, makeToken: { "t" })
      try store.ensure(key: "k", defaultEnabled: true)
      let result = TokenRotation.run(store: store, key: "nope", macDeviceId: "mac")
      #expect(!result.succeeded)
      #expect(result.lines.first?.contains("--list-outputs") == true)
      #expect(store.record(for: "k")?.token == "t")
    }
  }

  /// A file the helper could not read holds pinned secrets; nothing is written over it.
  @Test func anUnreadableFileIsLeftAlone() throws {
    try withTempDir { dir in
      let file = dir.appendingPathComponent("outputs.json")
      try "{ not json".write(to: file, atomically: true, encoding: .utf8)
      let result = TokenRotation.run(store: OutputStateStore(directory: dir), key: "k", macDeviceId: "mac")
      #expect(!result.succeeded)
      #expect(try String(contentsOf: file, encoding: .utf8) == "{ not json")
    }
  }
}
