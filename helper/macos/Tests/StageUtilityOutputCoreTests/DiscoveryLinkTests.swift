import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct ProbeLinkStateTests {
  let noRoute = Int32(65)
  let denied = Int32(1)

  func fail(_ n: Int, errno: Int32) -> [SendFailure] {
    (0..<n).map { SendFailure(target: "en\($0) 192.0.2.\($0)", errno: errno) }
  }

  @Test func aSocketThatCannotOpenIsSaidOnceAndOpeningItAgainIsSaid() {
    var s = ProbeLinkState()
    #expect(s.socketOpen)
    #expect(s.socketOpenFailed("bind failed") == .socketUnavailable("bind failed"))
    #expect(!s.socketOpen)
    // The slow retries that follow say nothing more.
    #expect(s.socketOpenFailed("bind failed") == .none)
    #expect(s.socketOpenFailed("bind failed") == .none)
    #expect(s.socketOpened() == .socketRestored)
    #expect(s.socketOpen)
    #expect(s.socketOpened() == .none)
  }

  @Test func aSocketThatOpensFirstTimeSaysNothing() {
    var s = ProbeLinkState()
    #expect(s.socketOpened() == .none)
  }

  /// A probe every two seconds, every one failing: one line, not a line each.
  @Test func everyProbeFailingIsSaidOnceNotOnEveryTick() {
    var s = ProbeLinkState()
    let first = s.sent(failures: fail(2, errno: denied), targets: 2, inferLocalNetworkDenial: true)
    guard case .sendFailed(let why, let likely) = first else {
      Issue.record("expected sendFailed, got \(first)")
      return
    }
    #expect(why.contains("en0 192.0.2.0: Operation not permitted"))
    #expect(!likely)
    for _ in 0..<5 {
      #expect(s.sent(failures: fail(2, errno: denied), targets: 2, inferLocalNetworkDenial: true) == .none)
    }
    #expect(s.sent(failures: [], targets: 2, inferLocalNetworkDenial: true) == .sendRecovered)
    #expect(s.sent(failures: [], targets: 2, inferLocalNetworkDenial: true) == .none)
  }

  @Test func oneDeadInterfaceAmongWorkingOnesIsNothing() {
    var s = ProbeLinkState()
    #expect(s.sent(failures: fail(1, errno: noRoute), targets: 2, inferLocalNetworkDenial: true) == .none)
  }

  @Test func noRouteOnEveryBroadcastTargetLooksLikeARefusedPermission() {
    var s = ProbeLinkState()
    guard case .sendFailed(_, let likely) = s.sent(failures: fail(2, errno: noRoute), targets: 2, inferLocalNetworkDenial: true)
    else {
      Issue.record("expected sendFailed")
      return
    }
    #expect(likely)
  }

  /// One unicast to a server that is switched off gives the same error. Not a denial.
  @Test func aUnicastNoRouteIsNotTakenForARefusedPermission() {
    var s = ProbeLinkState()
    guard case .sendFailed(_, let likely) = s.sent(failures: fail(1, errno: noRoute), targets: 1, inferLocalNetworkDenial: false)
    else {
      Issue.record("expected sendFailed")
      return
    }
    #expect(!likely)
  }

  @Test func aMixOfErrorsOnEveryTargetIsFailureButNotADenial() {
    var s = ProbeLinkState()
    let mixed = [SendFailure(target: "a", errno: noRoute), SendFailure(target: "b", errno: denied)]
    guard case .sendFailed(_, let likely) = s.sent(failures: mixed, targets: 2, inferLocalNetworkDenial: true) else {
      Issue.record("expected sendFailed")
      return
    }
    #expect(!likely)
  }

  /// First "operation not permitted", then "no route": a different trouble is news.
  @Test func aChangeOfCauseIsSaidAgain() {
    var s = ProbeLinkState()
    _ = s.sent(failures: fail(1, errno: denied), targets: 1, inferLocalNetworkDenial: true)
    guard case .sendFailed(_, true) = s.sent(failures: fail(1, errno: noRoute), targets: 1, inferLocalNetworkDenial: true) else {
      Issue.record("expected a new sendFailed")
      return
    }
  }

  @Test func noTargetsAtAllIsNotAFailureToSend() {
    var s = ProbeLinkState()
    #expect(s.sent(failures: [], targets: 0, inferLocalNetworkDenial: true) == .none)
  }

  @Test func anUnresolvedServerIsSaidOnce() {
    var s = ProbeLinkState()
    #expect(s.resolved(host: "booth.example", ok: true) == .none)
    #expect(s.resolved(host: "booth.example", ok: false) == .targetUnresolved("booth.example"))
    #expect(s.resolved(host: "booth.example", ok: false) == .none)
    #expect(s.resolved(host: "booth.example", ok: true) == .targetResolved)
  }
}

@Suite struct ReplyFilterTests {
  func reply(_ id: String, claimed: Bool? = nil) -> DiscoveryReply {
    DiscoveryReply(serverId: id, name: id, url: "http://192.0.2.10:8788", claimed: claimed)
  }

  /// Two servers on their Screens page at once must not swap its page back and forth.
  @Test func anUnboundOutputFollowsTheFirstServerToAnswer() {
    var f = ReplyFilter()
    #expect(f.decide(reply("a", claimed: false), boundTo: nil) == .accept(.keep))
    #expect(f.decide(reply("b", claimed: false), boundTo: nil) == .ignore(firstTime: true))
    #expect(f.decide(reply("b"), boundTo: nil) == .ignore(firstTime: false))
    #expect(f.decide(reply("a", claimed: false), boundTo: nil) == .accept(.keep))
    #expect(f.following == "a")
  }

  @Test func anUnboundOutputMovesToTheServerThatSetsItUp() {
    var f = ReplyFilter()
    #expect(f.decide(reply("a", claimed: false), boundTo: nil) == .accept(.keep))
    #expect(f.decide(reply("b", claimed: true), boundTo: nil) == .accept(.bind("b")))
    #expect(f.following == "b")
  }

  /// Released by its own server, it follows whoever answers next.
  @Test func aReleaseEndsTheFollowing() {
    var f = ReplyFilter()
    #expect(f.decide(reply("a", claimed: true), boundTo: "a") == .accept(.keep))
    #expect(f.decide(reply("a", claimed: false), boundTo: "a") == .accept(.forget("a")))
    #expect(f.following == nil)
    #expect(f.decide(reply("b", claimed: false), boundTo: nil) == .accept(.keep))
  }

  /// A rogue host's answer to a bound output is an error worth its own line, even
  /// after an unbound output's ordinary one was said.
  @Test func eachKindOfIgnoredAnswerIsSaidOnce() {
    var f = ReplyFilter()
    #expect(f.decide(reply("a"), boundTo: nil) == .accept(.bind("a")))
    #expect(f.decide(reply("b"), boundTo: nil) == .ignore(firstTime: true))
    #expect(f.decide(reply("rogue"), boundTo: "a") == .ignore(firstTime: true))
    #expect(f.decide(reply("rogue"), boundTo: "a") == .ignore(firstTime: false))
  }

  @Test func aBoundOutputBelievesItsServer() {
    var f = ReplyFilter()
    #expect(f.decide(reply("a"), boundTo: "a") == .accept(.keep))
  }

  /// Any host on the LAN can answer, and the answer names the address the output
  /// then loads its token to.
  @Test func aBoundOutputIgnoresAnotherServerAndSaysSoOnce() {
    var f = ReplyFilter()
    #expect(f.decide(reply("rogue"), boundTo: "a") == .ignore(firstTime: true))
    #expect(f.decide(reply("rogue"), boundTo: "a") == .ignore(firstTime: false))
    #expect(f.decide(reply("other"), boundTo: "a") == .ignore(firstTime: false))
    #expect(f.decide(reply("a"), boundTo: "a") == .accept(.keep))
  }
}

@Suite struct OutputBindingTests {
  func reply(_ id: String, claimed: Bool?) -> DiscoveryReply {
    DiscoveryReply(serverId: id, name: id, url: "http://192.0.2.10:8788", claimed: claimed)
  }

  @Test func rememberedOnlyWhenAServerSaysItIsSetUpThere() {
    #expect(OutputBinding.change(after: reply("a", claimed: true), boundTo: nil) == .bind("a"))
    #expect(OutputBinding.change(after: reply("a", claimed: false), boundTo: nil) == .keep)
    #expect(OutputBinding.change(after: reply("a", claimed: true), boundTo: "a") == .keep)
  }

  @Test func forgottenOnlyWhenItsOwnServerSaysItIsNot() {
    #expect(OutputBinding.change(after: reply("a", claimed: false), boundTo: "a") == .forget("a"))
    #expect(OutputBinding.change(after: reply("b", claimed: false), boundTo: "a") == .keep)
  }

  /// A server older than the field: remembered on any answer.
  @Test func anOlderServersAnswerIsRemembered() {
    #expect(OutputBinding.change(after: reply("a", claimed: nil), boundTo: nil) == .bind("a"))
    #expect(OutputBinding.change(after: reply("a", claimed: nil), boundTo: "a") == .keep)
  }
}

@Suite struct UnreachableScheduleTests {
  @Test func flagsOnlyAfterThirtyUnansweredProbesToABoundServer() {
    #expect(!ProbeSchedule.flagsUnreachable(unanswered: 30, answered: false, boundTo: "s"))
    #expect(ProbeSchedule.flagsUnreachable(unanswered: 31, answered: false, boundTo: "s"))
  }

  @Test func neverFlagsAnUnboundOrAnsweredOutput() {
    #expect(!ProbeSchedule.flagsUnreachable(unanswered: 500, answered: false, boundTo: nil))
    #expect(!ProbeSchedule.flagsUnreachable(unanswered: 500, answered: true, boundTo: "s"))
  }

  @Test func aMissingSocketIsRetriedAtTheSlowRate() {
    #expect(ProbeSchedule.interval(unanswered: 0, answered: false, socketOpen: false) == 30)
    #expect(ProbeSchedule.interval(unanswered: 0, answered: false, socketOpen: true) == 2)
  }
}
