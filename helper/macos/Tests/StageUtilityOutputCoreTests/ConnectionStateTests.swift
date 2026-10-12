import Testing
@testable import StageUtilityOutputCore

@Suite struct ConnectionStateTests {
  typealias F = StatusText.OutputFacts
  let url = "http://192.0.2.10:8788"

  @Test func noOutputOnIsNoOutputs() {
    #expect(StatusText.connection([]) == .noOutputs)
    #expect(StatusText.connection([F(active: false, serverURL: url, loaded: true)]) == .noOutputs)
  }

  @Test func outputsWithNoServerYetAreSearching() {
    #expect(StatusText.connection([F(active: true)]) == .searching)
  }

  @Test func aServerFileAloneIsConfiguredUntilSomethingHasLoadedFromIt() {
    #expect(StatusText.connection([F(active: true, serverURL: url)]) == .configured(address: "192.0.2.10:8788"))
  }

  @Test func anAnswerOrALoadIsConnected() {
    #expect(StatusText.connection([F(active: true, serverURL: url, serverName: "Booth")])
      == .connected(name: "Booth", address: "192.0.2.10:8788"))
    #expect(StatusText.connection([F(active: true, serverURL: url, loaded: true)])
      == .connected(name: "Stage Utility", address: "192.0.2.10:8788"))
  }

  /// One output that cannot load its page outranks the others being fine.
  @Test func anyFailingOutputIsTheHeadline() {
    let outputs = [
      F(active: true, serverURL: url, serverName: "Booth", loaded: true),
      F(active: true, serverURL: "http://192.0.2.20:8788", unreachable: true),
    ]
    #expect(StatusText.connection(outputs) == .unreachable(address: "192.0.2.20:8788"))
  }

  /// A turned-off output keeps its last facts; none of them count.
  @Test func aTurnedOffOutputIsNotConsidered() {
    let outputs = [
      F(active: false, serverURL: url, unreachable: true),
      F(active: true, serverURL: url, loaded: true),
    ]
    #expect(StatusText.connection(outputs) == .connected(name: "Stage Utility", address: "192.0.2.10:8788"))
  }

  @Test func aFailureWithNoAddressFallsThrough() {
    #expect(StatusText.connection([F(active: true, unreachable: true)]) == .searching)
  }
}
