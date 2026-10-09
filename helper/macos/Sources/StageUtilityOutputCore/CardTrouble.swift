import Foundation

/// When a card output starts and stops repeating or dropping frames, for the log.
///
/// Fed the output's running counts once a second. Trouble is logged when it starts
/// and when it ends, never each second it goes on: a page that misses a frame now
/// and then would otherwise fill the log. It has ended only after `quietPolls`
/// polls in a row with none, so trouble every other second is one episode, not a
/// line a second.
public struct CardTrouble {
  public enum Kind: String, Equatable {
    case repeats = "repeating frames"
    case drops = "dropping frames"
  }

  public enum Event: Equatable {
    /// `count` is how many in the poll that started it.
    case started(Kind, count: UInt64)
    /// `total` is how many over the whole episode.
    case stopped(Kind, total: UInt64)
  }

  public static let defaultQuietPolls = 5

  private struct Track {
    var last: UInt64?
    var active = false
    var quiet = 0
    var episode: UInt64 = 0
  }

  private let quietPolls: Int
  private var repeats = Track()
  private var drops = Track()

  public init(quietPolls: Int = CardTrouble.defaultQuietPolls) {
    self.quietPolls = quietPolls
  }

  /// The output's counts now. Counts that go down (a new output) start afresh.
  public mutating func observe(repeated: UInt64, dropped: UInt64) -> [Event] {
    var events: [Event] = []
    if let e = Self.step(&repeats, now: repeated, kind: .repeats, quietPolls: quietPolls) { events.append(e) }
    if let e = Self.step(&drops, now: dropped, kind: .drops, quietPolls: quietPolls) { events.append(e) }
    return events
  }

  private static func step(_ t: inout Track, now: UInt64, kind: Kind, quietPolls: Int) -> Event? {
    defer { t.last = now }
    guard let last = t.last, now >= last else { return nil }
    let added = now - last
    if added > 0 {
      t.quiet = 0
      t.episode += added
      if !t.active {
        t.active = true
        return .started(kind, count: added)
      }
      return nil
    }
    guard t.active else { return nil }
    t.quiet += 1
    if t.quiet < quietPolls { return nil }
    let total = t.episode
    t = Track(last: now)
    return .stopped(kind, total: total)
  }
}
