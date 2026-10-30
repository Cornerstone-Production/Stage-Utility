import Foundation
import Testing

@testable import StageUtilityOutputCore

@Suite struct OutputSwitchTests {
  let at = Date(timeIntervalSince1970: 1_760_000_000.123)

  // MARK: The body the server reads

  @Test func anOutputThatIsOffPostsOnlyThatItIsOff() {
    #expect(String(decoding: HealthPost.offBody(), as: UTF8.self) == #"{"enabled":false}"#)
    // The server refuses figures sent with it, so there must be none.
    #expect(String(decoding: HealthPost.offBody(changeId: "c1"), as: UTF8.self) == #"{"changed":"c1","enabled":false}"#)
  }

  @Test func anOutputThatIsOnSaysSoAndCarriesAChangeUntilItIsTaken() throws {
    let plain = HealthPost.body(HealthSample(fps: 60), at: at)
    let object = try #require(try JSONSerialization.jsonObject(with: plain) as? [String: Any])
    #expect(object["enabled"] as? Bool == true)
    #expect(object["changed"] == nil, "a change id was sent that nobody made")
    let changed = try #require(
      try JSONSerialization.jsonObject(with: HealthPost.body(HealthSample(fps: 60), at: at, changeId: "c1")) as? [String: Any])
    #expect(changed["changed"] as? String == "c1")
  }

  // MARK: The server's answer

  @Test func theAnswerIsAJSONBooleanAndNothingElse() {
    func answer(_ json: String) -> Bool? { OutputSwitch.answer(in: Data(json.utf8)) }
    #expect(answer(#"{"ok":true,"enabled":false}"#) == false)
    #expect(answer(#"{"ok":true,"enabled":true}"#) == true)
    // A server older than the switch says nothing, and the helper then changes nothing.
    #expect(answer(#"{"ok":true}"#) == nil)
    for notAnAnswer in [#"{"enabled":0}"#, #"{"enabled":1}"#, #"{"enabled":"false"}"#, #"{"enabled":null}"#, "not json", "[]", ""] {
      #expect(answer(notAnAnswer) == nil, "\(notAnAnswer) was taken as an answer")
    }
  }

  // MARK: What to do with it

  @Test func anAnswerThatDiffersIsTakenAndOneThatAgreesIsNot() {
    #expect(OutputSwitch.decide(held: true, answer: false, sentChange: nil, stale: false).apply == false)
    #expect(OutputSwitch.decide(held: false, answer: true, sentChange: nil, stale: false).apply == true)
    #expect(OutputSwitch.decide(held: true, answer: true, sentChange: nil, stale: false).apply == nil)
    #expect(OutputSwitch.decide(held: true, answer: nil, sentChange: nil, stale: false).apply == nil)
  }

  /// A change made in the window while a post was on its way: that post's answer is
  /// the value from before, and applying it would undo the change.
  @Test func anAnswerToAPostSentBeforeAChangeIsNotApplied() {
    let d = OutputSwitch.decide(held: false, answer: true, sentChange: nil, stale: true)
    #expect(d.apply == nil, "a stale answer undid a change made in the window")
  }

  @Test func aChangeTheServerSawIsAcknowledgedEvenFromAStalePost() {
    #expect(OutputSwitch.decide(held: true, answer: true, sentChange: "c1", stale: false).acknowledged == "c1")
    #expect(OutputSwitch.decide(held: true, answer: true, sentChange: "c1", stale: true).acknowledged == "c1")
    #expect(OutputSwitch.decide(held: true, answer: true, sentChange: nil, stale: false).acknowledged == nil)
  }

  /// The server has already taken this change once and Screens has said something
  /// newer since: its answer wins, and the change is not sent again.
  @Test func aChangeAlreadyTakenAndSinceOverruledGivesWayToScreens() {
    let d = OutputSwitch.decide(held: false, answer: true, sentChange: "c1", stale: false)
    #expect(d.acknowledged == "c1")
    #expect(d.apply == true)
  }

  @Test func eachChangeGetsItsOwnId() {
    #expect(OutputSwitch.newChangeId() != OutputSwitch.newChangeId())
    #expect(OutputSwitch.newChangeId().count <= 64, "the server refuses an id over 64 characters")
  }

  // MARK: Kept in the file

  @Test func aChangeMadeInTheWindowIsKeptUntilTheServerTakesIt() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir, makeToken: { "tok" })
      try store.ensure(key: "k", defaultEnabled: true)
      try store.setEnabledLocally(false, changeId: "c1", key: "k")
      // A new run of the helper reads both from the file, so it still sends the change.
      let again = OutputStateStore(directory: dir)
      #expect(again.record(for: "k")?.enabled == false)
      #expect(again.record(for: "k")?.pendingChange == "c1")
      // A newer change is not cleared by the older one's answer.
      try again.setEnabledLocally(true, changeId: "c2", key: "k")
      try again.acknowledgeChange("c1", key: "k")
      #expect(again.record(for: "k")?.pendingChange == "c2")
      try again.acknowledgeChange("c2", key: "k")
      #expect(again.record(for: "k")?.pendingChange == nil)
    }
  }

  /// A server that no longer has the output set up is not waiting to be told about a
  /// change, and a later set-up elsewhere must not be sent the id of an old one.
  @Test func anOutputTheServerForgotDropsItsPendingChange() throws {
    try withTempDir { dir in
      let store = OutputStateStore(directory: dir, makeToken: { "tok" })
      try store.ensure(key: "k", defaultEnabled: true)
      try store.setBoundTo("srv", key: "k")
      try store.setEnabledLocally(false, changeId: "c1", key: "k")
      try store.apply(.forget("srv"), key: "k")
      #expect(store.record(for: "k")?.boundTo == nil)
      #expect(store.record(for: "k")?.pendingChange == nil, "a forgotten output kept a change nobody will take")
      #expect(store.record(for: "k")?.enabled == false, "the value itself is kept")
    }
  }

  @Test func anOutputsFileFromBeforeTheSwitchStillReads() throws {
    try withTempDir { dir in
      let old = #"{"outputs":{"k":{"enabled":false,"token":"tok","boundTo":"srv"}}}"#
      try Data(old.utf8).write(to: dir.appendingPathComponent("outputs.json"))
      let store = OutputStateStore(directory: dir)
      #expect(store.readProblem == nil)
      #expect(store.record(for: "k")?.enabled == false)
      #expect(store.record(for: "k")?.pendingChange == nil)
    }
  }
}
