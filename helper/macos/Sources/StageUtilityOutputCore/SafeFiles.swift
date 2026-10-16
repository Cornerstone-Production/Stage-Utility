import Foundation

/// What reading a small state file found. "Missing" and "unreadable" are different
/// answers: a missing file is a first run and gets made, an unreadable one holds
/// something that exists (a secret the server has pinned, an id every binding is
/// keyed on) and must never be written over.
public enum FileRead: Equatable {
  case missing
  case data(Data)
  case unreadable(String)

  public static func read(_ url: URL) -> FileRead {
    do {
      return .data(try Data(contentsOf: url))
    } catch let error as NSError {
      let missing =
        (error.domain == NSCocoaErrorDomain && (error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError))
        || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT))
      return missing ? .missing : .unreadable(error.localizedDescription)
    }
  }
}

/// Files this helper writes hold secrets (an output's token) or the one id every
/// setup is keyed on, so they are made private from the first byte, not narrowed
/// afterwards: a `chmod` after the write leaves a window in which another account
/// could read them.
public enum PrivateFiles {
  /// The directory, and any that are missing above it, readable by the owner only.
  public static func makeDirectory(_ dir: URL) throws {
    try FileManager.default.createDirectory(
      at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  }

  /// Write `data` to `file` through a temporary file that is created with `mode`,
  /// then renamed over it, so a reader sees the old file or the whole new one.
  ///
  /// `beforeRename` sees the temporary file before it replaces anything. It is how a
  /// test looks at the mode the bytes were written under.
  public static func write(_ data: Data, to file: URL, mode: mode_t = 0o600, beforeRename: (URL) -> Void = { _ in }) throws {
    let temp = file.deletingLastPathComponent().appendingPathComponent(".\(file.lastPathComponent).\(UUID().uuidString).tmp")
    let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL, mode)
    guard fd >= 0 else { throw posixError("create \(temp.lastPathComponent)") }
    // Closed here and nowhere else, whichever way this leaves: a descriptor closed
    // early can be handed out again, and closing it a second time would close that.
    defer { close(fd) }
    do {
      try data.withUnsafeBytes { buffer in
        var offset = 0
        while offset < buffer.count {
          let n = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
          if n < 0 {
            if errno == EINTR { continue }
            throw posixError("write \(temp.lastPathComponent)")
          }
          offset += n
        }
      }
      if fsync(fd) != 0 { throw posixError("flush \(temp.lastPathComponent)") }
      beforeRename(temp)
      if rename(temp.path, file.path) != 0 { throw posixError("rename onto \(file.lastPathComponent)") }
    } catch {
      unlink(temp.path)
      throw error
    }
  }

  private static func posixError(_ what: String) -> NSError {
    NSError(
      domain: NSPOSIXErrorDomain, code: Int(errno),
      userInfo: [NSLocalizedDescriptionKey: "could not \(what): \(String(cString: strerror(errno)))"])
  }
}
