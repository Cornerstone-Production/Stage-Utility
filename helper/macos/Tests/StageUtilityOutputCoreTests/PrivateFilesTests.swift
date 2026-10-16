import Darwin
import Foundation
import Testing
@testable import StageUtilityOutputCore

/// umask is process-wide, so these run one at a time.
@Suite(.serialized) struct PrivateFilesTests {
  func mode(_ url: URL) throws -> Int {
    (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
  }

  /// The bytes of a token must never sit in a file another account can read, even for
  /// a moment. With the most permissive umask, the temporary file is 0600 BEFORE it is
  /// renamed into place; narrowing it afterwards would show 0666 here.
  @Test func theFileIsPrivateFromItsFirstByte() throws {
    let old = umask(0)
    defer { umask(old) }
    try withTempDir { dir in
      let file = dir.appendingPathComponent("outputs.json")
      var seen: Int?
      try PrivateFiles.write(Data("secret".utf8), to: file, beforeRename: { temp in seen = try? mode(temp) })
      #expect(seen == 0o600)
      #expect(try mode(file) == 0o600)
      #expect(try String(contentsOf: file, encoding: .utf8) == "secret")
      // No temporary file is left beside it.
      let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
      #expect(names == ["outputs.json"])
    }
  }

  @Test func theDirectoryIsPrivateWhenItIsMade() throws {
    let old = umask(0)
    defer { umask(old) }
    try withTempDir { dir in
      let sub = dir.appendingPathComponent("a/b")
      try PrivateFiles.makeDirectory(sub)
      #expect(try mode(sub) == 0o700)
    }
  }

  @Test func replacesAnExistingFileWhole() throws {
    try withTempDir { dir in
      let file = dir.appendingPathComponent("f")
      try PrivateFiles.write(Data("one".utf8), to: file)
      try PrivateFiles.write(Data("two".utf8), to: file)
      #expect(try String(contentsOf: file, encoding: .utf8) == "two")
    }
  }

  /// A rename that fails must not close the temporary file's descriptor a second
  /// time: by then its number can belong to anything else the process has opened.
  /// The hook opens a file while the write is at the rename, which is where a
  /// descriptor closed early would be handed out again; the failed rename (onto a
  /// directory) then throws, and what the hook opened must still be open.
  @Test func aFailedRenameClosesTheTemporaryFileOnce() throws {
    try withTempDir { dir in
      let target = dir.appendingPathComponent("a-directory")
      try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
      var bystander: Int32 = -1
      #expect(throws: (any Error).self) {
        try PrivateFiles.write(
          Data("x".utf8), to: target, beforeRename: { _ in bystander = open("/dev/null", O_RDONLY) })
      }
      #expect(bystander >= 0)
      #expect(fcntl(bystander, F_GETFD) != -1, "the failed write closed a descriptor it no longer owned")
      close(bystander)
      // The temporary file is gone and the directory is untouched.
      #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == ["a-directory"])
    }
  }

  @Test func aFailedWriteLeavesNothingBehind() throws {
    try withTempDir { dir in
      let file = dir.appendingPathComponent("no-such-folder/f")
      #expect(throws: (any Error).self) { try PrivateFiles.write(Data("x".utf8), to: file) }
      let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
      #expect(names == [])
    }
  }
}
