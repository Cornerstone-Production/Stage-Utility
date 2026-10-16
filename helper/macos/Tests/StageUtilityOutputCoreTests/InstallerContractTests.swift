import Foundation
import Testing
@testable import StageUtilityOutputCore

/// The helper finds what scripts/kiosk/install-macos.sh leaves behind by name: the
/// state folder, the files in it, the migration marker, and the LaunchAgent it
/// writes. Those names are written in both places, so they are read from the script
/// here rather than trusted to match.
@Suite struct InstallerContractTests {
  /// The script's lines. A script that cannot be found is a failure, not a skip: a
  /// guard that passes without looking is how a rename gets through.
  func installerLines() throws -> [String] {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    let script = url.appendingPathComponent("scripts/kiosk/install-macos.sh")
    return try String(contentsOf: script, encoding: .utf8).components(separatedBy: "\n")
  }

  /// The value in the script's first `NAME=value` line (STATE_DIR is assigned again
  /// inside a script the installer writes out, which comes later).
  func assignment(_ name: String, in lines: [String]) throws -> String {
    let line = try #require(lines.first { $0.hasPrefix("\(name)=") }, "the installer has no \(name)= line")
    return String(line.dropFirst(name.count + 1))
  }

  @Test func theLaunchAgentIsNamedByTheInstallersLabel() throws {
    let label = try assignment("HELPER_LABEL", in: try installerLines())
    #expect(HelperPaths.launchAgentName == "\(label).plist")
  }

  @Test func theStateFolderIsTheInstallers() throws {
    let value = try assignment("STATE_DIR", in: try installerLines())
    let prefix = "\"$ROOT"
    try #require(value.hasPrefix(prefix) && value.hasSuffix("\""), "STATE_DIR is no longer \"$ROOT/...\": \(value)")
    let path = String(value.dropFirst(prefix.count).dropLast())
    let paths = HelperPaths.resolve(environment: [:], home: URL(fileURLWithPath: "/Users/someone"))
    #expect(paths.systemDir.path == path)
  }

  @Test func theMigrationMarkerIsTheInstallers() throws {
    #expect(try assignment("MARKER", in: try installerLines()) == "\"$STATE_DIR/\(KioskMigration.markerFileName)\"")
  }

  /// The files the helper reads from the installer's folder, each of which the
  /// installer writes or refuses a link at.
  @Test func theFilesTheHelperReadsAreTheOnesTheInstallerWrites() throws {
    let text = try installerLines().joined(separator: "\n")
    for name in [
      "device-id",
      "server",
      "token",
    ] {
      #expect(text.contains("$STATE_DIR/\(name)"), "the installer never mentions $STATE_DIR/\(name)")
    }
  }
}
