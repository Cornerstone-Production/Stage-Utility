import DeckLinkKit
import Foundation
import StageUtilityOutputCore
import os

/// The unified log, subsystem `com.stageutility.output`. Read it with
///
///     log stream --level info --predicate 'subsystem == "com.stageutility.output"'
///
/// Decisions and failures only: an output coming or going, an answer from a
/// server, a reload, a renderer or GPU process gone, a card output falling
/// behind or catching up, a refused health post, and the DeckLink layer's own
/// lines (`decklink`: the driver, ports opened, refused, lost). A healthy frame is
/// not logged.
enum Log {
  enum Category: String, CaseIterable {
    case app, discovery, output, health, cef, state, decklink
  }

  /// `--log-stderr`: also print each line, for a terminal run.
  nonisolated(unsafe) static var mirrorToStderr = false

  private static let loggers: [Category: Logger] = Dictionary(
    uniqueKeysWithValues: Category.allCases.map { ($0, Logger(subsystem: "com.stageutility.output", category: $0.rawValue)) })

  // Public on purpose: the default is to redact interpolated strings, which would
  // turn every line into "<private>" for the person reading it at 9am on a Sunday.
  // The one secret near a line is an output's token, in the address it loads: every
  // line has the query cut from any address in it first (`Redact`).
  static func notice(_ category: Category, _ message: String) {
    let line = Redact.addresses(in: message)
    loggers[category]?.notice("\(line, privacy: .public)")
    mirror("notice", category, line)
  }

  static func error(_ category: Category, _ message: String) {
    let line = Redact.addresses(in: message)
    loggers[category]?.error("\(line, privacy: .public)")
    mirror("error", category, line)
  }

  private static func mirror(_ level: String, _ category: Category, _ message: String) {
    guard mirrorToStderr else { return }
    FileHandle.standardError.write(Data("[\(category.rawValue)] \(level): \(message)\n".utf8))
  }
}

extension Log {
  /// Where a `DeckLinkOutputPort` and the `DeckLinkInventory` write: the same
  /// subsystem and category as `DeckLinkLog`, and mirrored to stderr like the rest.
  static func decklink(_ level: DeckLinkLog.Level, _ message: String) {
    switch level {
    case .info: notice(.decklink, message)
    case .error: error(.decklink, message)
    }
  }
}
