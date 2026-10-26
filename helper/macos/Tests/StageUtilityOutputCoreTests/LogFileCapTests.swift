import Darwin
import Foundation
import Testing
@testable import StageUtilityOutputCore

struct LogFileCapTests {
  func lines(_ range: ClosedRange<Int>) -> String {
    range.map { "line \($0)\n" }.joined()
  }

  @Test func aFileOverTheCapKeepsItsMostRecentWholeLines() throws {
    try withTempDir { dir in
      let file = dir.appendingPathComponent("chromium.log")
      try Data(lines(1...1000).utf8).write(to: file)
      // 104 bytes back from the end is 4 bytes into "line 989\n": a cut mid-line.
      let outcome = try LogFileCap.enforce(file, cap: 4000, keep: 104)
      let text = try String(contentsOf: file, encoding: .utf8)
      #expect(text == lines(990...1000), "the partial line the cut landed in is dropped")
      #expect(outcome == .trimmed(from: lines(1...1000).utf8.count, kept: text.utf8.count))
    }
  }

  @Test func aFileUnderTheCapIsLeftAlone() throws {
    try withTempDir { dir in
      let file = dir.appendingPathComponent("chromium.log")
      try Data(lines(1...10).utf8).write(to: file)
      #expect(try LogFileCap.enforce(file, cap: 4000, keep: 100) == .underCap)
      #expect(try String(contentsOf: file, encoding: .utf8) == lines(1...10))
    }
  }

  @Test func noFileYetIsNotAnError() throws {
    try withTempDir { dir in
      let outcome = try LogFileCap.enforce(dir.appendingPathComponent("chromium.log"))
      #expect(outcome == .missing)
    }
  }

  /// Chromium keeps its log open for appending and never reopens it. Its next line
  /// must land after the kept lines, not past the old end with a hole before it.
  @Test func aWriterThatAppendsGoesOnWritingAtTheNewEnd() throws {
    try withTempDir { dir in
      let file = dir.appendingPathComponent("chromium.log")
      try Data(lines(1...1000).utf8).write(to: file)
      let fd = open(file.path, O_WRONLY | O_APPEND)
      #expect(fd >= 0)
      defer { close(fd) }
      _ = try LogFileCap.enforce(file, cap: 4000, keep: 100)
      let next = "line 1001\n"
      #expect(write(fd, next, next.utf8.count) == next.utf8.count)
      let text = try String(contentsOf: file, encoding: .utf8)
      #expect(text.hasSuffix("line 1000\nline 1001\n"))
      #expect(text.utf8.count <= 100 + next.utf8.count)
      #expect(!text.contains("\0"))
    }
  }
}
