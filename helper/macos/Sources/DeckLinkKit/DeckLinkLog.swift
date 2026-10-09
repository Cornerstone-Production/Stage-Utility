import Foundation
import os

/// The DeckLink layer's lines in the unified log, under the helper's subsystem:
///
///     log stream --level info --predicate 'subsystem == "com.stageutility.output" && category == "decklink"'
///
/// Decisions and failures only: the driver missing, a port opened or refused, a
/// port lost or reopened, repeats or drops starting and stopping. Healthy frames
/// are not logged.
public enum DeckLinkLog {
  public enum Level { case info, error }

  static let logger = Logger(subsystem: "com.stageutility.output", category: "decklink")

  /// Where a port's lines go unless it is given somewhere else.
  public static func write(_ level: Level, _ message: String) {
    switch level {
    case .info: logger.info("\(message, privacy: .public)")
    case .error: logger.error("\(message, privacy: .public)")
    }
  }
}
