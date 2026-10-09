import Foundation
import Testing
@testable import StageUtilityOutputCore

/// A Mac upgraded from the Chrome kiosk keeps its screen: its main display's output
/// takes the kiosk's bare device id and token, once.
@Suite struct KioskMigrationTests {
  let main = OutputDescriptor(kind: .display, key: "uuid-main", name: "Display 1 · A", port: "Display 1", isMain: true)
  let second = OutputDescriptor(kind: .display, key: "uuid-2", name: "Display 2 · B", port: "Display 2")
  let third = OutputDescriptor(kind: .display, key: "uuid-3", name: "Display 3 · C", port: "Display 3")

  func mac(marker: Bool, token: String? = "kiosk-token", source: MacIdentity.Source = .installer) -> MacIdentity {
    var m = MacIdentity(deviceId: "mac-1", source: source, server: nil, installerToken: token)
    m.migratedFromKiosk = marker
    return m
  }

  func store(_ dir: URL) -> OutputStateStore {
    var n = 0
    return OutputStateStore(directory: dir, makeToken: { n += 1; return "own-\(n)" })
  }

  @Test func theMarkerIsReadFromTheInstallersFolder() {
    withTempDir { dir in
      try! "mac-1".write(to: dir.appendingPathComponent("device-id"), atomically: true, encoding: .utf8)
      #expect(!MacIdentity.load(paths: HelperPaths(systemDir: dir, userDir: dir)).migratedFromKiosk)
      try! "".write(to: dir.appendingPathComponent("migrated-from-kiosk"), atomically: true, encoding: .utf8)
      #expect(MacIdentity.load(paths: HelperPaths(systemDir: dir, userDir: dir)).migratedFromKiosk)
    }
  }

  @Test func withoutTheMarkerTheMainDisplayIsAnOrdinaryOutput() throws {
    try withTempDir { dir in
      let s = store(dir)
      let r = try s.ensure(main, mac: mac(marker: false))
      #expect(r == OutputRecord(enabled: false, token: "own-1"))
      #expect(r.deviceId(mac: "mac-1", key: main.key) == "mac-1.uuid-main")
    }
  }

  @Test func withTheMarkerAOneDisplayMacKeepsItsKioskIdentity() throws {
    try withTempDir { dir in
      let r = try store(dir).ensure(main, mac: mac(marker: true))
      #expect(r == OutputRecord(enabled: true, token: "kiosk-token", kioskIdentity: true))
      #expect(r.deviceId(mac: "mac-1", key: main.key) == "mac-1")
    }
  }

  /// Several displays: the main display alone takes it; the others are new outputs.
  @Test func onlyTheMainDisplayTakesIt() throws {
    try withTempDir { dir in
      let s = store(dir)
      let m = mac(marker: true)
      for d in [second, main, third] { try s.ensure(d, mac: m) }
      #expect(s.record(for: main.key)?.kioskIdentity == true)
      #expect(s.record(for: second.key) == OutputRecord(enabled: true, token: "own-1"))
      #expect(s.record(for: third.key) == OutputRecord(enabled: true, token: "own-2"))
    }
  }

  /// Stored, so a restart with the menu bar on another display does not move it,
  /// and the new main display never becomes a second holder.
  @Test func theChoiceIsStoredAndNeverGivenTwice() throws {
    try withTempDir { dir in
      let m = mac(marker: true)
      try store(dir).ensure(main, mac: m)
      let movedMenuBar = OutputDescriptor(kind: .display, key: second.key, name: second.name, port: second.port, isMain: true)
      let reopened = store(dir)
      let r = try reopened.ensure(movedMenuBar, mac: m)
      #expect(r.kioskIdentity == nil)
      #expect(r.deviceId(mac: "mac-1", key: second.key) == "mac-1.uuid-2")
      #expect(reopened.record(for: main.key)?.kioskIdentity == true)
    }
  }

  /// The holder unplugged is still the holder: a different main display is not
  /// given the identity in its absence.
  @Test func anAbsentHolderStillHoldsIt() throws {
    try withTempDir { dir in
      let m = mac(marker: true)
      try store(dir).ensure(main, mac: m)
      let other = OutputDescriptor(kind: .display, key: "uuid-new", name: "New", port: "Display 1", isMain: true)
      let r = try store(dir).ensure(other, mac: m)
      #expect(r.kioskIdentity == nil)
    }
  }

  /// An output that already has a record is never converted: its own id and token
  /// may be what a screen is bound to.
  @Test func anExistingRecordIsNotRecomputedWhenTheMarkerAppears() throws {
    try withTempDir { dir in
      try store(dir).ensure(main, mac: mac(marker: false))
      let r = try store(dir).ensure(main, mac: mac(marker: true))
      #expect(r == OutputRecord(enabled: false, token: "own-1"))
    }
  }

  /// The server pinned the installer's token; with no token, or an id the helper
  /// made itself, there is no kiosk binding to keep.
  @Test func itNeedsTheInstallersIdAndToken() throws {
    try withTempDir { dir in
      let r = try store(dir).ensure(main, mac: mac(marker: true, token: nil))
      #expect(r.kioskIdentity == nil)
    }
    try withTempDir { dir in
      let r = try store(dir).ensure(main, mac: mac(marker: true, source: .generated))
      #expect(r.kioskIdentity == nil)
    }
  }

  @Test func aCardOutputNeverTakesIt() throws {
    try withTempDir { dir in
      let card = VirtualCards.outputs(count: 1)[0]
      let r = try store(dir).ensure(card, mac: mac(marker: true))
      #expect(r.kioskIdentity == nil)
    }
  }

  /// `--list-outputs` shows the id the output really goes by.
  @Test func theListingShowsTheBareId() throws {
    try withTempDir { dir in
      let s = store(dir)
      let m = mac(marker: true)
      try s.ensure(main, mac: m)
      let lines = OutputListing.lines(identity: m, displays: [main], record: { s.record(for: $0) })
      #expect(lines.last?.hasPrefix("uuid-main\tmac-1\t") == true)
    }
  }
}
