import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct ScheduleTests {
  @Test func reloadBacksOffThenHolds() {
    #expect((1...7).map { Backoff.reloadDelay(failures: $0) } == [2, 4, 8, 16, 30, 30, 30])
    #expect(Backoff.reloadDelay(failures: 0) == 2)
    #expect(Backoff.reloadDelay(failures: 10_000) == 30)
  }

  /// Discovery restarts once when the run of failures crosses the line, not once per
  /// retry after it.
  @Test func rediscoveryIsAskedForExactlyOnceAtTheThirdFailure() {
    #expect((1...6).map { Backoff.shouldRediscover(afterFailureNumber: $0) } == [false, false, true, false, false, false])
  }

  @Test func probesEveryTwoSecondsThenBackOff() {
    #expect(ProbeSchedule.interval(unanswered: 0, answered: false) == 2)
    #expect(ProbeSchedule.interval(unanswered: 9, answered: false) == 2)
    #expect(ProbeSchedule.interval(unanswered: 10, answered: false) == 30)
  }

  /// Under the server's 90 s listing window, or the output drops off Screens.
  @Test func anAnsweredOutputStillProbesInsideTheListingWindow() {
    let interval = ProbeSchedule.interval(unanswered: 0, answered: true)
    #expect(interval == 30)
    #expect(interval < 90)
  }
}

@Suite struct HealthTests {
  let at = Date(timeIntervalSince1970: 1_760_000_000.123)

  @Test func bodyIsExactBytes() {
    let body = HealthPost.body(HealthSample(fps: 59.9401, repeated: 1.6694, dropped: 1), at: at)
    #expect(String(decoding: body, as: UTF8.self) == #"{"at":1760000000123,"dropped":1,"enabled":true,"fps":59.94,"repeated":1.67}"#)
    let card = HealthPost.body(HealthSample(fps: 59.94, repeated: 0, dropped: 0, latencyMs: 20.0441), at: at)
    #expect(
      String(decoding: card, as: UTF8.self)
        == #"{"at":1760000000123,"dropped":0,"enabled":true,"fps":59.94,"latencyMs":20.04,"repeated":0}"#)
  }

  func keys(_ body: Data) throws -> [String] {
    try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any]).keys.sorted()
  }

  /// The body's keys, exactly, as the server's `parseHealthReport` reads them:
  /// `latencyMs` beside the four when a card output measured it, and left out, not
  /// null, when nothing did or it is outside what the server takes (a body it
  /// refused would lose the whole report).
  @Test func theBodyCarriesTheLatencyOnlyWhenThereIsOne() throws {
    #expect(
      try keys(HealthPost.body(HealthSample(fps: 60, latencyMs: 20), at: at)) == [
        "at",
        "dropped",
        "enabled",
        "fps",
        "latencyMs",
        "repeated",
      ])
    for latency in [nil, -1, 10_001, .infinity, .nan] as [Double?] {
      #expect(
        try keys(HealthPost.body(HealthSample(fps: 60, latencyMs: latency), at: at)) == [
          "at",
          "dropped",
          "enabled",
          "fps",
          "repeated",
        ], "\(String(describing: latency))")
    }
  }

  @Test func requestGoesToTheDevicesHealthRoute() throws {
    let req = try #require(
      HealthPost.request(server: "http://192.0.2.10:8788/", deviceId: "mac.disp", token: "tok", body: Data("{}".utf8)))
    #expect(req.url?.absoluteString == "http://192.0.2.10:8788/api/devices/mac.disp/health")
    #expect(req.httpMethod == "POST")
    #expect(req.value(forHTTPHeaderField: "content-type") == "application/json")
    #expect(req.value(forHTTPHeaderField: "x-device-token") == "tok")
    #expect(req.httpBody == Data("{}".utf8))
  }

  @Test func theIdIsEscapedInThePath() throws {
    let req = try #require(HealthPost.request(server: "http://h:1", deviceId: "a/b", token: "t", body: Data()))
    #expect(req.url?.absoluteString == "http://h:1/api/devices/a%2Fb/health")
  }
}

@Suite struct StatusTextTests {
  typealias I = StatusText.Input

  @Test func offReasons() {
    #expect(StatusText.outputLine(I(enabled: false, isMain: true, serverKnown: true))
      == "The Mac's desktop. Off, so the menu bar stays here.")
    #expect(StatusText.outputLine(I(enabled: false, isMain: false, serverKnown: true)) == "Turned off here")
  }

  @Test func onStates() {
    #expect(StatusText.outputLine(I(enabled: true, isMain: false, serverKnown: false)) == "Looking for Stage Utility")
    #expect(StatusText.outputLine(I(enabled: true, isMain: false, serverKnown: true))
      == "Waiting to be set up on the server")
    #expect(StatusText.outputLine(I(enabled: true, isMain: false, serverKnown: true, unreachable: true))
      == "Cannot reach the server. Retrying")
  }

  @Test func boundShowsTheScreenNameAndFps() {
    #expect(StatusText.outputLine(I(enabled: true, isMain: false, serverKnown: true, boundScreenName: "Main stage left", fps: 59.94))
      == "Main stage left · 59.94 fps")
    #expect(StatusText.outputLine(I(enabled: true, isMain: false, serverKnown: true, boundScreenName: "Main stage left", fps: 0))
      == "Main stage left")
    #expect(StatusText.outputLine(I(enabled: true, isMain: false, serverKnown: true, showingBound: true))
      == "Showing a screen")
  }

  @Test func connectionLines() {
    let c = StatusText.connectionLine(.connected(name: "Stage Utility", address: "192.0.2.10:8788"))
    #expect(c.prefix + (c.name ?? "") + (c.middle ?? "") + (c.address ?? "") == "Connected to Stage Utility at 192.0.2.10:8788")
    #expect(StatusText.connectionLine(.searching).prefix == "Looking for Stage Utility on the network")
  }
}
