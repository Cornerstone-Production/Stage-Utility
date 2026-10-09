import Foundation

/// What became of one output's `--dump-frames` picture.
public enum FrameDumpOutcome: Equatable, Sendable {
  case written
  /// A card output whose page has drawn nothing new since the last dump: a still
  /// page, which is not a fault. Its frame is dumped again when the page draws.
  case noNewFrame
  case failed(String)
}

/// What the log says about each output's dumps: a failure every time, and a page
/// with nothing new to dump once, when it goes quiet, not every 5 s while it stays
/// that way.
public struct FrameDumpLog: Equatable {
  public enum Line: Equatable {
    case notice(String)
    case error(String)
  }

  private var quiet: Set<String> = []

  public init() {}

  public mutating func line(for key: String, label: String, _ outcome: FrameDumpOutcome) -> Line? {
    switch outcome {
    case .written:
      quiet.remove(key)
      return nil
    case .noNewFrame:
      guard quiet.insert(key).inserted else { return nil }
      return .notice("\(label): frame dump: no new frame since the last dump; the next is written when the page draws")
    case .failed(let why):
      return .error("\(label): frame dump: \(why)")
    }
  }
}
