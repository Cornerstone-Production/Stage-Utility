import Foundation
import StageUtilityOutputCore

/// `--frame-timings`: every card output's slots appended to one CSV file
/// (`FrameTimingCSV`), off the ports' queues.
final class FrameTimingFile: @unchecked Sendable {
  private let handle: FileHandle
  private let queue = DispatchQueue(label: "com.stageutility.output.frame-timings", qos: .utility)

  init(_ file: URL) throws {
    try Data((FrameTimingCSV.header + "\n").utf8).write(to: file)
    handle = try FileHandle(forWritingTo: file)
    try handle.seekToEnd()
  }

  func append(output: String, _ timings: [FrameTiming]) {
    let text = timings.map { FrameTimingCSV.line(output: output, $0) + "\n" }.joined()
    queue.async { [handle] in
      do {
        try handle.write(contentsOf: Data(text.utf8))
      } catch {
        Log.error(.app, "--frame-timings: could not write: \(error.localizedDescription)")
      }
    }
  }
}
