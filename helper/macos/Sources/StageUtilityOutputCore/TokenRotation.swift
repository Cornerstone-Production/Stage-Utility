import Foundation

/// `--new-token <output key>`: replace one output's secret, for when it has been
/// seen by someone it should not have been (on a screen, in a photo, a log).
///
/// The server pins the secret an output showed when it was set up, and a screen set
/// up again keeps that pin (`claim` in main/services/kiosk-devices-store.ts), so a
/// new secret alone only locks the output out. It takes three steps: the new secret
/// here, the output released from its screen on the server (which drops the old
/// pin), and the output set up on that screen again (which pins the new one). Until
/// the release, the old secret still opens the screen.
///
/// The helper must not be running: it keeps `outputs.json` in memory and would write
/// the old secret back over the new one.
public enum TokenRotation {
  public struct Result: Equatable {
    public var lines: [String]
    public var succeeded: Bool
  }

  /// Do it, and say what happened and what is left to do. The secret itself is
  /// never printed.
  public static func run(store: OutputStateStore, key: String, macDeviceId: String?) -> Result {
    if let problem = store.readProblem {
      return Result(lines: ["\(problem). Nothing was changed."], succeeded: false)
    }
    guard let record = store.record(for: key) else {
      return Result(
        lines: ["No output \(key) is stored. --list-outputs shows each output's key (the first column)."],
        succeeded: false)
    }
    // With no Mac id stored there is no device id to name; say "this output".
    let device = macDeviceId.map { record.deviceId(mac: $0, key: key) }
    do {
      _ = try store.newToken(key: key)
    } catch {
      return Result(
        lines: ["The new token for \(key) could not be saved: \(error.localizedDescription). Nothing was changed."],
        succeeded: false)
    }
    return Result(
      lines: [
        "\(key)\(device.map { " (device \($0))" } ?? "") has a new token, saved in \(store.file.path).",
        "The server still holds the old one, and it still opens the screen until you:",
        "  1. start the helper again;",
        "  2. in Stage Utility, open the screen this output showed, and Release it (Screen settings > Device);",
        "  3. set it up on that screen again when \(device ?? "this output") appears under Not set up yet.",
      ],
      succeeded: true)
  }
}
