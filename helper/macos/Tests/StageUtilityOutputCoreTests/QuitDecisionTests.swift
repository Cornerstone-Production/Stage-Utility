import Testing
@testable import StageUtilityOutputCore

/// Not unit-tested: that macOS takes the answer as a quit and not a refusal. That is
/// AppKit's reply to the quit Apple event, and was checked by sending one to the
/// built app (`osascript -e 'tell application id "com.stageutility.output" to quit'`):
/// before, it answered "User canceled. (-128)", the reply that cancels a logout.
@Suite struct QuitDecisionTests {
  /// Chromium running, the first quit closes everything; a second while it does
  /// joins it rather than closing twice. Without Chromium, AppKit quits as usual.
  @Test func aQuitClosesOnceAndNeverRefuses() {
    #expect(QuitDecision.onTerminate(engineRunning: true, alreadyQuitting: false) == .closeOutputsThenEndLoop)
    #expect(QuitDecision.onTerminate(engineRunning: true, alreadyQuitting: true) == .alreadyClosing)
    #expect(QuitDecision.onTerminate(engineRunning: false, alreadyQuitting: false) == .letAppKitTerminate)
    #expect(QuitDecision.onTerminate(engineRunning: false, alreadyQuitting: true) == .letAppKitTerminate)
  }
}
