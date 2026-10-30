import Foundation

/// An output's switch, as the server and the Mac's own window share it.
///
/// The server decides: the answer to every accepted health post carries
/// `{ok: true, enabled: <bool>}`, the value Screens wants for this output, and the
/// helper applies it. The one thing that goes the other way is a switch changed in
/// the helper's own window, which is sent with an id (`HealthPost.body`) until the
/// server has taken it, so that a Mac that is switched off by hand is not switched
/// straight back on by the next answer.
public enum OutputSwitch {
  /// `enabled` from the answer to a health post, or nil when it is absent (a server
  /// older than the switch) or is not a JSON boolean. 0 and 1 are not an answer:
  /// JSONSerialization hands them back as the same type as a boolean.
  public static func answer(in data: Data) -> Bool? {
    guard
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let n = obj["enabled"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID()
    else { return nil }
    return n.boolValue
  }

  /// What the helper does with the answer to an accepted post.
  public struct Decision: Equatable {
    /// The id the post carried: the server has seen that change, so it need not be
    /// sent again. Nil when the post carried none.
    public var acknowledged: String?
    /// The value to take over from the server, when it differs from the Mac's own.
    public var apply: Bool?
  }

  /// `held` is what the Mac holds now; `sentChange` the id the post carried.
  ///
  /// The answer is applied only when it differs, and only when no switch has been
  /// changed in the window since the post went out (`stale`): an answer to a post
  /// sent before then describes the old value and would undo the change. The id
  /// is acknowledged either way, since the server did see it.
  public static func decide(held: Bool, answer: Bool?, sentChange: String?, stale: Bool) -> Decision {
    let differs = answer.flatMap { $0 != held ? $0 : nil }
    return Decision(acknowledged: sentChange, apply: stale ? nil : differs)
  }

  /// A fresh id for a change made in the window.
  public static func newChangeId() -> String { UUID().uuidString }
}
