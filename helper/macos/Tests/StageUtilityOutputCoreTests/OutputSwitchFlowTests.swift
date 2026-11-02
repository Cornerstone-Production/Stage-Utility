import Foundation
import Testing

@testable import StageUtilityOutputCore

/// The state machine around `OutputSwitch.decide`: the real store and the real
/// sequence of window changes, posts and answers, which `decide` alone cannot show.
@MainActor @Suite struct OutputSwitchFlowTests {
  /// One output "k", on, in a fresh store; ids "c1", "c2"… in order.
  private func make(_ dir: URL, failures: ErrorBox = ErrorBox()) throws -> (OutputSwitchFlow, OutputStateStore) {
    let store = OutputStateStore(directory: dir, makeToken: { "tok" })
    try store.ensure(key: "k", defaultEnabled: true)
    var n = 0
    let flow = OutputSwitchFlow(
      store: store, newChangeId: { n += 1; return "c\(n)" }, saveFailed: { failures.errors.append($0) })
    return (flow, store)
  }

  final class ErrorBox { var errors: [Error] = [] }

  @Test func theServerTurnsAnOutputOffAndItStaysOff() throws {
    try withTempDir { dir in
      let (flow, store) = try make(dir)
      #expect(flow.answered(flow.ticket(for: "k"), answer: false) == false)
      #expect(store.record(for: "k")?.enabled == false)
      #expect(flow.ticket(for: "k").change == nil, "the server's own change is sent back to it")
    }
  }

  /// Off in the window, then Screens says on: the post that carried the change is
  /// answered with the newer value, which is taken, and the change is not sent again.
  @Test func aChangeTheServerOverrulesIsNotSentAgain() throws {
    try withTempDir { dir in
      let (flow, store) = try make(dir)
      flow.changeInWindow("k", false)
      let ticket = flow.ticket(for: "k")
      #expect(ticket.change == "c1")
      #expect(flow.answered(ticket, answer: true) == true)
      #expect(store.record(for: "k")?.enabled == true)
      #expect(store.record(for: "k")?.pendingChange == nil)
      #expect(flow.ticket(for: "k").change == nil, "a change the server overruled is still being sent")
    }
  }

  @Test func anAnswerThatAgreesOrSaysNothingChangesNothing() throws {
    try withTempDir { dir in
      let (flow, store) = try make(dir)
      #expect(flow.answered(flow.ticket(for: "k"), answer: true) == nil)
      #expect(flow.answered(flow.ticket(for: "k"), answer: nil) == nil)
      #expect(store.record(for: "k")?.enabled == true)
    }
  }

  /// The case the real switch is for: off in the window while Screens still says on.
  @Test func aChangeInTheWindowIsSentUntilTakenAndNotUndoneByAnAnswerToAnOlderPost() throws {
    try withTempDir { dir in
      let (flow, store) = try make(dir)
      let before = flow.ticket(for: "k")  // a post is on its way
      flow.changeInWindow("k", false)
      #expect(store.record(for: "k")?.enabled == false)
      // Its answer, "on", describes the value from before the change.
      #expect(flow.answered(before, answer: true) == nil, "a stale answer undid the change made in the window")
      #expect(store.record(for: "k")?.enabled == false)
      // The next post carries the change, and is answered with what the server now holds.
      let next = flow.ticket(for: "k")
      #expect(next.change == "c1")
      #expect(flow.answered(next, answer: false) == nil)
      #expect(store.record(for: "k")?.pendingChange == nil, "the server took the change and it is still pending")
    }
  }

  /// Window on, then Screens off, then Screens on again: the last word is on.
  @Test func screensHasTheLastWordOnceTheServerHasTakenTheChange() throws {
    try withTempDir { dir in
      let (flow, store) = try make(dir)
      flow.changeInWindow("k", false)
      flow.changeInWindow("k", true)
      #expect(flow.ticket(for: "k").change == "c2", "the newer change did not replace the older")
      #expect(flow.answered(flow.ticket(for: "k"), answer: true) == nil)  // taken
      #expect(flow.answered(flow.ticket(for: "k"), answer: false) == false)  // Screens says off
      #expect(store.record(for: "k")?.enabled == false)
      #expect(flow.answered(flow.ticket(for: "k"), answer: true) == true)  // and on again
      #expect(store.record(for: "k")?.enabled == true)
    }
  }

  /// A post sent under the value from before the server's own change must not turn
  /// the output back when its answer arrives.
  @Test func anApplyFromTheServerMakesPostsAlreadyOnTheirWayStale() throws {
    try withTempDir { dir in
      let (flow, store) = try make(dir)
      let first = flow.ticket(for: "k")
      let second = flow.ticket(for: "k")
      #expect(flow.answered(first, answer: false) == false)
      // The second was sent while the output was still on; its answer says on.
      #expect(flow.answered(second, answer: true) == nil, "a post from before the change turned the output back")
      #expect(store.record(for: "k")?.enabled == false)
    }
  }

  @Test func outputsDoNotShareACount() throws {
    try withTempDir { dir in
      let (flow, store) = try make(dir)
      try store.ensure(key: "j", defaultEnabled: true)
      let onJ = flow.ticket(for: "j")
      flow.changeInWindow("k", false)
      #expect(flow.answered(onJ, answer: false) == false, "a change on one output made another's answer stale")
    }
  }

  @Test func aKeyWithNoRecordIsLeftAlone() throws {
    try withTempDir { dir in
      let (flow, _) = try make(dir)
      #expect(flow.answered(OutputSwitchFlow.Ticket(key: "gone", generation: 0, change: "c9"), answer: false) == nil)
    }
  }

  @Test func aFailedSaveIsReportedAndTheValueIsKept() throws {
    try withTempDir { dir in
      let failures = ErrorBox()
      let (flow, store) = try make(dir, failures: failures)
      // The file's directory is gone, so the save throws; the value must still hold.
      try FileManager.default.removeItem(at: dir)
      try Data().write(to: dir)  // a file where the directory was
      flow.changeInWindow("k", false)
      #expect(!failures.errors.isEmpty, "a save that failed was not reported")
      #expect(store.record(for: "k")?.enabled == false)
      #expect(store.record(for: "k")?.pendingChange == "c1")
    }
  }

  /// A save that fails is told to the caller from every write, not only the window's:
  /// the acknowledge and the apply each have their own catch.
  @Test func aFailedSaveWhileAcknowledgingIsReported() throws {
    try withTempDir { dir in
      let failures = ErrorBox()
      let (flow, store) = try make(dir, failures: failures)
      flow.changeInWindow("k", false)
      let ticket = flow.ticket(for: "k")
      try FileManager.default.removeItem(at: dir)
      try Data().write(to: dir)
      #expect(flow.answered(ticket, answer: false) == nil)  // agrees: only the acknowledge is written
      #expect(failures.errors.count == 1, "a failed acknowledge was swallowed")
      #expect(store.record(for: "k")?.pendingChange == nil)
    }
  }

  @Test func aFailedSaveWhileApplyingIsReportedAndTheValueIsTaken() throws {
    try withTempDir { dir in
      let failures = ErrorBox()
      let (flow, store) = try make(dir, failures: failures)
      let ticket = flow.ticket(for: "k")
      try FileManager.default.removeItem(at: dir)
      try Data().write(to: dir)
      #expect(flow.answered(ticket, answer: false) == false)
      #expect(failures.errors.count == 1, "a failed apply was swallowed")
      #expect(store.record(for: "k")?.enabled == false)
    }
  }
}
