import Foundation
import StageUtilityOutputCore

/// `--frame-timings`: every card output's slots appended to one CSV file
/// (`FrameTimingCSV`), off the ports' queues.
final class FrameTimingFile: @unchecked Sendable {
  private let handle: FileHandle
  private let queue = DispatchQueue(label: "com.stageutility.output.frame-timings", qos: .utility)
  /// Why writing stopped, on the queue: after one failed write nothing more is
  /// tried, so the log says it once.
  private var failed: String?

  init(_ file: URL) throws {
    try Data((FrameTimingCSV.header + "\n").utf8).write(to: file)
    handle = try FileHandle(forWritingTo: file)
    try handle.seekToEnd()
  }

  func append(output: String, _ timings: [FrameTiming]) {
    let text = timings.map { FrameTimingCSV.line(output: output, $0) + "\n" }.joined()
    queue.async { [self] in
      guard failed == nil else { return }
      do {
        try handle.write(contentsOf: Data(text.utf8))
      } catch {
        failed = error.localizedDescription
        Log.error(.app, "--frame-timings: could not write, so no more timings are written: \(error.localizedDescription)")
      }
    }
  }
}
