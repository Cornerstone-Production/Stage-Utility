import Foundation

/// Keeps a log file another process appends to under a size cap, by moving its
/// most recent lines to the front and cutting the rest, in place.
///
/// Chromium writes `chromium.log` itself, through a file it opened for appending
/// and never reopens, so the file cannot be renamed away from under it: a renamed
/// file would go on growing under its new name. Appends land at the end of the
/// file wherever that is, so cutting it in place is safe for the writer. A line
/// appended between the read and the cut is lost, which a log of warnings can
/// afford. Uncapped it reached 594 MB in three days of WebRTC decoder warnings.
public enum LogFileCap {
  /// Trimmed once it is larger than this.
  public static let capBytes = 20 * 1024 * 1024
  /// What a trim keeps: the most recent lines, about this many bytes of them.
  public static let keepBytes = 5 * 1024 * 1024
  /// How often a running helper checks.
  public static let checkInterval: TimeInterval = 10 * 60

  /// What a check did.
  public enum Outcome: Equatable, Sendable {
    case missing
    case underCap
    /// Was `from` bytes; `kept` of its most recent remain.
    case trimmed(from: Int, kept: Int)
  }

  /// Trim `file` to its last `keep` bytes, starting at a line, when it is larger
  /// than `cap`. Throws when the file is there but cannot be read or written.
  public static func enforce(_ file: URL, cap: Int = capBytes, keep: Int = keepBytes) throws -> Outcome {
    precondition(keep <= cap, "a trim keeps no more than the cap")
    guard FileManager.default.fileExists(atPath: file.path) else { return .missing }
    let handle = try FileHandle(forUpdating: file)
    defer { try? handle.close() }
    let size = Int(try handle.seekToEnd())
    guard size > cap else { return .underCap }
    try handle.seek(toOffset: UInt64(size - keep))
    var tail = try handle.readToEnd() ?? Data()
    // Start at a whole line: drop the partial one the cut landed in.
    if let newline = tail.firstIndex(of: UInt8(ascii: "\n")) {
      tail = tail.subdata(in: tail.index(after: newline)..<tail.endIndex)
    }
    try handle.seek(toOffset: 0)
    try handle.write(contentsOf: tail)
    try handle.truncate(atOffset: UInt64(tail.count))
    return .trimmed(from: size, kept: tail.count)
  }
}
