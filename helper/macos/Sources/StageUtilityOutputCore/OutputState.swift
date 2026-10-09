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
  /// Set when an unreadable file was moved aside at load.
  public private(set) var recoveredFrom: URL?

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

  private func load() {
    guard let data = FileManager.default.contents(atPath: file.path) else { return }
    if let decoded = try? JSONDecoder().decode(File.self, from: data) {
      records = decoded.outputs
      return
    }
    // Unreadable. Moved aside, not deleted: it holds tokens the server has pinned,
    // and a person may be able to fix it.
    let aside = file.deletingLastPathComponent().appendingPathComponent(
      "outputs.json.unreadable-\(Int(Date().timeIntervalSince1970))")
    if (try? FileManager.default.moveItem(at: file, to: aside)) != nil { recoveredFrom = aside }
  }

  public func record(for key: String) -> OutputRecord? { records[key] }

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

  public func setBoundTo(_ server: String?, key: String) throws {
    guard var r = records[key], r.boundTo != server else { return }
    r.boundTo = server
    records[key] = r
    try save()
  }

  private func save() throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
    let data = try encoder.encode(File(outputs: records))
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: file, options: .atomic)
    // The tokens are secrets: the account that runs the helper, nobody else.
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
  }
}
