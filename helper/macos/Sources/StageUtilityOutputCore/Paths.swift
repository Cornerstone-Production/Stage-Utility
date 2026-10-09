import Foundation

/// Where the helper's files live.
public struct HelperPaths: Equatable {
  /// The installer's directory: `device-id`, `server`, `token`. Read, never written
  /// (the helper has no right to write there).
  public var systemDir: URL
  /// The helper's own: `outputs.json`, and a `generated-device-id` it made when the
  /// installer never wrote one.
  public var userDir: URL

  public static let overrideVariable = "STAGE_UTILITY_OUTPUT_STATE_DIR"

  public init(systemDir: URL, userDir: URL) {
    self.systemDir = systemDir
    self.userDir = userDir
  }

  /// `STAGE_UTILITY_OUTPUT_STATE_DIR`, when set and not empty, replaces BOTH
  /// directories, for tests and development: nothing then reads or writes the
  /// real ones.
  public static func resolve(environment: [String: String], home: URL) -> HelperPaths {
    if let override = environment[overrideVariable], !override.isEmpty {
      let dir = URL(fileURLWithPath: override, isDirectory: true)
      return HelperPaths(systemDir: dir, userDir: dir)
    }
    return HelperPaths(
      systemDir: URL(fileURLWithPath: "/Library/Application Support/StageUtility", isDirectory: true),
      userDir: home.appendingPathComponent("Library/Application Support/StageUtilityOutput", isDirectory: true))
  }
}

/// The Mac-level facts the installer leaves behind.
public struct MacIdentity: Equatable {
  public enum Source: Equatable {
    /// Read from the installer's `device-id`.
    case installer
    /// Made by the helper because the installer never ran.
    case generated
  }

  /// The helper's own file, named differently from the installer's `device-id` so
  /// the two stay distinguishable when one folder holds both (the state-dir
  /// override).
  public static let generatedFileName = "generated-device-id"

  public var deviceId: String
  public var source: Source
  /// From the `server` file. When present, discovery is skipped.
  public var server: String?
  /// Set when the `server` file named an address that cannot be used (it has a
  /// path): discovery then runs as if there were no file.
  public var serverProblem: String?
  /// The installer's Mac-level token: the secret a Chrome kiosk on this Mac was
  /// bound with. Only an output that takes over that kiosk's identity sends it
  /// (`KioskMigration`); every other output has its own.
  public var installerToken: String?
  /// The installer replaced a Chrome kiosk on this Mac with the helper, and left
  /// `migrated-from-kiosk` to say so.
  public var migratedFromKiosk = false
  /// Set when a generated id could not be saved: the id works for this run, and a
  /// restart would mint another and orphan every binding.
  public var saveError: String?

  /// Set when a file that exists could not be read: the id or the server file. The
  /// helper does not write over it.
  public var readProblem: String?

  /// What is on disk, or nil when the Mac has no device id yet. Writes nothing.
  public static func stored(paths: HelperPaths) -> MacIdentity? {
    let r = read(paths)
    return r.identity
  }

  /// The id this Mac goes by, made and saved on first run when the installer never
  /// wrote one.
  public static func load(paths: HelperPaths, makeId: () -> String = { UUID().uuidString.lowercased() }) -> MacIdentity {
    var r = read(paths)
    if let identity = r.identity { return identity }
    let id = makeId()
    var failure: String?
    if let blocked = r.generatedUnreadable {
      // A saved id exists and cannot be read. Making a new one and saving it would
      // orphan every binding made under the old; use a temporary one and say so.
      failure = "the saved device id could not be read (\(blocked)), so this run uses a temporary one and does not save it"
    } else {
      do {
        try PrivateFiles.makeDirectory(paths.userDir)
        try PrivateFiles.write(Data(id.utf8), to: paths.userDir.appendingPathComponent(MacIdentity.generatedFileName))
      } catch {
        failure = "could not save a new device id to \(paths.userDir.path): \(error.localizedDescription)"
      }
    }
    r.base.deviceId = id
    r.base.source = .generated
    r.base.saveError = failure
    return r.base
  }

  /// A file as text: nil when missing or empty. An unreadable one is reported to
  /// `problem` and is nil too.
  private static func text(_ dir: URL, _ name: String, problem: inout String?) -> String? {
    switch FileRead.read(dir.appendingPathComponent(name)) {
    case .missing: return nil
    case .unreadable(let why):
      problem = "\(name) could not be read (\(why))"
      return nil
    case .data(let data):
      guard let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
      return s
    }
  }

  private static func read(_ paths: HelperPaths) -> (identity: MacIdentity?, base: MacIdentity, generatedUnreadable: String?) {
    var problem: String?
    var server: String?
    var serverProblem: String?
    if let text = text(paths.systemDir, "server", problem: &problem) {
      switch EnrollURL.check(server: text) {
      case .success(let address): server = address
      case .failure(let refusal): serverProblem = "the server file: \(refusal)"
      }
    }
    let token = text(paths.systemDir, "token", problem: &problem)
    var base = MacIdentity(
      deviceId: "", source: .generated, server: server, serverProblem: serverProblem, installerToken: token, saveError: nil,
      readProblem: nil)
    base.migratedFromKiosk = FileManager.default.fileExists(
      atPath: paths.systemDir.appendingPathComponent(KioskMigration.markerFileName).path)
    if let id = text(paths.systemDir, "device-id", problem: &problem) {
      base.deviceId = id
      base.source = .installer
      base.readProblem = problem
      return (base, base, nil)
    }
    // Not from the installer. A previous run may already have made one.
    var generatedProblem: String?
    if let id = text(paths.userDir, MacIdentity.generatedFileName, problem: &generatedProblem) {
      base.deviceId = id
      base.readProblem = problem
      return (base, base, nil)
    }
    base.readProblem = problem ?? generatedProblem
    return (nil, base, generatedProblem)
  }
}
