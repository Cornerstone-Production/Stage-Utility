import Foundation

/// The two writers of an output's switch, and the rule that keeps them from undoing
/// each other: the window (`changeInWindow`) and the server's answer to a health post
/// (`answered`). `OutputSwitch` holds the pure decision; this holds the state around
/// it: the count of window changes per output, and the stored value and pending id.
///
/// It stores and decides. Opening or closing the output, logging and the menu bar
/// stay with the caller, which does them for each value these return.
@MainActor
public final class OutputSwitchFlow {
  /// What a health post went out under. Its answer is read against this, not against
  /// whatever is true when the answer arrives.
  public struct Ticket: Equatable {
    public var key: String
    /// The window changes made to this output before the post went out.
    public var generation: Int
    /// The id of a window change the server has not taken, sent with the post.
    public var change: String?
  }

  private let store: OutputStateStore
  private let newChangeId: () -> String
  private let saveFailed: (Error) -> Void
  private var generations: [String: Int] = [:]

  /// `saveFailed` is told when the file could not be written. The value is kept in
  /// memory regardless (`OutputStateStore`), so the flow carries on.
  public init(
    store: OutputStateStore, newChangeId: @escaping () -> String = OutputSwitch.newChangeId,
    saveFailed: @escaping (Error) -> Void
  ) {
    self.store = store
    self.newChangeId = newChangeId
    self.saveFailed = saveFailed
  }

  /// The switch changed in the helper's window. Kept with a fresh id, which the
  /// posts carry until the server has taken it, so Screens shows it and does not
  /// undo it. Posts already on their way are now stale.
  public func changeInWindow(_ key: String, _ on: Bool) {
    generations[key, default: 0] += 1
    do { try store.setEnabledLocally(on, changeId: newChangeId(), key: key) } catch { saveFailed(error) }
  }

  /// What the next post for `key` goes out under.
  public func ticket(for key: String) -> Ticket {
    Ticket(key: key, generation: generations[key, default: 0], change: store.record(for: key)?.pendingChange)
  }

  /// The answer to an accepted post: the `enabled` it carried, nil when it carried
  /// none. Acknowledges the change the post sent, and takes the server's value when
  /// it differs from the Mac's and no window change has been made since the post
  /// went out. Returns the value taken, for the caller to apply to the output; nil
  /// when nothing changed.
  public func answered(_ ticket: Ticket, answer: Bool?) -> Bool? {
    guard let record = store.record(for: ticket.key) else { return nil }
    let decision = OutputSwitch.decide(
      held: record.enabled, answer: answer, sentChange: ticket.change,
      stale: ticket.generation != generations[ticket.key, default: 0])
    if let id = decision.acknowledged {
      do { try store.acknowledgeChange(id, key: ticket.key) } catch { saveFailed(error) }
    }
    guard let on = decision.apply else { return nil }
    // Counted like a window change: a post still on its way was sent under the value
    // from before this, and its answer must not turn the output back.
    generations[ticket.key, default: 0] += 1
    do { try store.setEnabled(on, key: ticket.key) } catch { saveFailed(error) }
    return on
  }
}
