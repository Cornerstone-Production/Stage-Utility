import Foundation

/// What the helper remembers about one output.
public struct OutputRecord: Codable, Equatable {
  /// The operator's choice, or the default from first sight. Stored rather than
  /// recomputed, so moving the menu bar to another display later does not switch
  /// a display on that was off.
  public var enabled: Bool
  /// This output's own secret, made once. The server pins it the first time the
  /// output is claimed, so another machine cannot ask for its screen.
  public var token: String
  /// The server that last answered this output.
  public var boundTo: String?
  /// This output took over the Chrome kiosk this Mac was before the helper: it goes
  /// by the Mac's bare device id with the installer's token, so the screen the
  /// kiosk was bound to stays bound. Decided once, when the record is made (see
  /// `KioskMigration`), and never given to a second output. Absent for every other.
  public var kioskIdentity: Bool?
  /// A card output's format, as its screen last set it (`VideoModes.normalised`);
  /// absent for the default and for a display. Kept so the port opens in it at the
  /// next start, rather than in the default and again in this once the screen has
  /// been read.
  public var videoMode: String?

  public init(
    enabled: Bool, token: String, boundTo: String? = nil, kioskIdentity: Bool? = nil, videoMode: String? = nil
  ) {
    self.enabled = enabled
    self.token = token
    self.boundTo = boundTo
    self.kioskIdentity = kioskIdentity
    self.videoMode = videoMode
  }

  /// The id this output announces itself and enrols under.
  public func deviceId(mac: String, key: String) -> String {
    kioskIdentity == true ? mac : DeviceIdentity.deviceId(mac: mac, key: key)
  }
}

/// A Mac that was a Chrome kiosk keeps its screen when the helper takes its place.
///
/// The kiosk was bound on the server under the Mac's bare device id, with the Mac's
/// `token` pinned as its secret. The helper names each output
/// `<mac id>.<output key>` with a token of its own, and leaves the main display off,
/// so without this the upgraded Mac would come up as new, unclaimed outputs and its
/// screen would go dark. `install-macos.sh` writes `migrated-from-kiosk` when it
/// replaces the kiosk with the helper; the helper then gives the main display's
/// output the kiosk's identity and turns it on.
public enum KioskMigration {
  public static let markerFileName = "migrated-from-kiosk"

  /// Whether a record being made now for `output` takes the kiosk's identity. Only
  /// the main display, only with the marker and the installer's own id and token
  /// (the secret the server pinned), and only while no stored output holds it.
  public static func takesKioskIdentity(_ output: OutputDescriptor, mac: MacIdentity, alreadyHeld: Bool) -> Bool {
    mac.migratedFromKiosk && mac.source == .installer && mac.installerToken != nil && !alreadyHeld
      && output.kind == .display && output.isMain
  }
}

/// `outputs.json` in the helper's own directory, keyed by output key.
///
/// Main-thread only; the helper has one owner for it.
public final class OutputStateStore {
  private struct File: Codable {
    var outputs: [String: OutputRecord]
  }

  public let file: URL
  private var records: [String: OutputRecord] = [:]
  private let makeToken: () -> String
  /// Set when the file exists and could not be read or understood. Nothing is
  /// written while it is set: the file holds tokens the server has pinned, and a
  /// fresh set written over it would lock every claimed output out.
  public private(set) var readProblem: String?

  public struct Unreadable: Error, CustomStringConvertible {
    public var why: String
    public var description: String { "outputs.json was not read at launch, so nothing is saved over it: \(why)" }
  }

  public init(directory: URL, makeToken: @escaping () -> String = OutputStateStore.randomToken) {
    self.file = directory.appendingPathComponent("outputs.json")
    self.makeToken = makeToken
    load()
  }

  /// 24 random bytes as hex, the length and alphabet of the shell agent's.
  public static func randomToken() -> String {
    var generator = SystemRandomNumberGenerator()
    return (0..<24).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
  }

  public var hasFile: Bool { FileManager.default.fileExists(atPath: file.path) }

  /// Missing is a first run. Present and unreadable, or not what it should be, is a
  /// problem to show, and nothing is written until a person has dealt with it.
  private func load() {
    switch FileRead.read(file) {
    case .missing:
      return
    case .unreadable(let why):
      readProblem = "outputs.json could not be read (\(why))"
    case .data(let data):
      do {
        records = try JSONDecoder().decode(File.self, from: data).outputs
      } catch {
        readProblem = "outputs.json is not what the helper wrote (\(error.localizedDescription))"
      }
    }
  }

  public func record(for key: String) -> OutputRecord? { records[key] }

  /// Whether any output, present or not, holds the kiosk's identity.
  public var kioskIdentityHeld: Bool { records.values.contains { $0.kioskIdentity == true } }

  /// The record for `output`, made on first sight. That is the one moment the
  /// kiosk's identity can be given (`KioskMigration`), so it is decided once and
  /// stored, and a display change later never moves it. Throws when it cannot be
  /// saved; the record is kept in memory regardless.
  @discardableResult
  public func ensure(_ output: OutputDescriptor, mac: MacIdentity) throws -> OutputRecord {
    if let existing = records[output.key] { return existing }
    guard KioskMigration.takesKioskIdentity(output, mac: mac, alreadyHeld: kioskIdentityHeld),
      let token = mac.installerToken
    else {
      return try ensure(key: output.key, defaultEnabled: defaultEnabled(kind: output.kind, isMain: output.isMain))
    }
    let record = OutputRecord(enabled: true, token: token, boundTo: nil, kioskIdentity: true)
    records[output.key] = record
    try save()
    return record
  }

  /// The record for `key`, made on first sight with a new token and the default
  /// for the kind of output. Throws when it cannot be saved.
  @discardableResult
  public func ensure(key: String, defaultEnabled: Bool) throws -> OutputRecord {
    if let existing = records[key] { return existing }
    let record = OutputRecord(enabled: defaultEnabled, token: makeToken(), boundTo: nil)
    records[key] = record
    try save()
    return record
  }

  public func setEnabled(_ enabled: Bool, key: String) throws {
    guard var r = records[key], r.enabled != enabled else { return }
    r.enabled = enabled
    records[key] = r
    try save()
  }

  /// The format a card output's screen set, normalised; nil for the default.
  public func setVideoMode(_ mode: String?, key: String) throws {
    let mode = VideoModes.normalised(mode)
    guard var r = records[key], r.videoMode != mode else { return }
    r.videoMode = mode
    records[key] = r
    try save()
  }

  public func setBoundTo(_ server: String?, key: String) throws {
    guard var r = records[key], r.boundTo != server else { return }
    r.boundTo = server
    records[key] = r
    try save()
  }

  private func save() throws {
    if let readProblem { throw Unreadable(why: readProblem) }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
    let data = try encoder.encode(File(outputs: records))
    try PrivateFiles.makeDirectory(file.deletingLastPathComponent())
    try PrivateFiles.write(data, to: file)
  }
}
