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
  /// The installer's Mac-level token. Read and kept; each output uses its own, so
  /// nothing sends this one yet. Step 4 uses it: a Mac already set up as a kiosk
  /// keeps its identity, so its single display becomes an output with this binding.
  public var installerToken: String?
  /// Set when a generated id could not be saved: the id works for this run, and a
  /// restart would mint another and orphan every binding.
  public var saveError: String?

  public static func load(paths: HelperPaths, makeId: () -> String = { UUID().uuidString.lowercased() }) -> MacIdentity {
    let fm = FileManager.default
    func read(_ dir: URL, _ name: String) -> String? {
      guard let data = fm.contents(atPath: dir.appendingPathComponent(name).path),
        let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty
      else { return nil }
      return s
    }
    let server = read(paths.systemDir, "server").flatMap { EnrollURL.normalise(server: $0) }
    let token = read(paths.systemDir, "token")
    if let id = read(paths.systemDir, "device-id") {
      return MacIdentity(deviceId: id, source: .installer, server: server, installerToken: token, saveError: nil)
    }
    // Not from the installer. A previous run may already have made one.
    if let id = read(paths.userDir, MacIdentity.generatedFileName) {
      return MacIdentity(deviceId: id, source: .generated, server: server, installerToken: token, saveError: nil)
    }
    let id = makeId()
    var failure: String?
    do {
      try fm.createDirectory(at: paths.userDir, withIntermediateDirectories: true)
      try Data(id.utf8).write(to: paths.userDir.appendingPathComponent(MacIdentity.generatedFileName), options: .atomic)
    } catch {
      failure = "could not save a new device id to \(paths.userDir.path): \(error.localizedDescription)"
    }
    return MacIdentity(deviceId: id, source: .generated, server: server, installerToken: token, saveError: failure)
  }
}
