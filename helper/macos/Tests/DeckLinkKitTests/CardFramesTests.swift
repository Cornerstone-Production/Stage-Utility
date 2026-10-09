import DeckLinkShim
import Foundation
import Testing
@testable import DeckLinkKit

/// Serialized: the count of frames the software clocks have made is one number for
/// the whole process, and only these tests make any.
@Suite(.serialized) struct CardFramesTests {
  func refusingPort(_ source: CardFrameSource, log: LogLines, cardFrames: Bool = false, refuses: Bool = true)
    -> DeckLinkOutputPort
  {
    DeckLinkOutputPort(
      label: "SDI test",
      hardware: .softwareClock(
        width: 16, height: 4, frameDuration: 1001, timeScale: 60000, ticksByItself: false,
        refusesHelperFrames: refuses),
      source: source, cardFrames: cardFrames, retryInterval: 3600, pollInterval: 3600, log: log.write)
  }

  /// The card refuses the helper's frames at the pre-roll: the port opens again
  /// in the card's frames by itself, says so once, and frames flow as before, each
  /// whole (the card's frames have longer lines than the helper's, so a copy that
  /// ignored that would tear them). Closing frees every frame the card made.
  @Test func aCardThatRefusesTheHelpersFramesGetsItsOwn() {
    let before = dl_fake_card_frames_alive()
    let log = LogLines()
    let port = refusingPort(NumberedSource(missing: [5]), log: log)
    #expect(port.open(videoMode: nil) == .running(mode: "16x4 at 59.94 on a software clock", frames: .card))
    #expect(port.frames == .card)
    #expect(dl_fake_card_frames_alive() - before == 3)

    port.fakeTick(10)
    let counts = port.counters
    #expect(counts.scheduled == 13)
    #expect(counts.repeated == 1)
    #expect(counts.dropped == 0)
    #expect(port.fakeShown() == [0, 1, 2, 3, 4, 4, 6, 7, 8, 9, 10])

    // Unplugged and back: still the card's frames, and the switch is not said again.
    port.fakeUnplug()
    port.sync()
    port.retry()
    port.sync()
    #expect(port.frames == .card)
    #expect(
      log.lines == [
        "SDI test: the card refused the helper's own frames, so it gets the card's frames, with one copy of each picture",
        "SDI test: opened in 16x4 at 59.94 on a software clock with the card's frames",
        "SDI test: lost (the device was removed); trying again every 3600 s",
        "SDI test: reopened in 16x4 at 59.94 on a software clock with the card's frames",
      ])

    port.close()
    #expect(dl_fake_card_frames_alive() == before)
  }

  /// Asked for card frames on a card that would take the helper's: card frames,
  /// and no line about a refusal that did not happen.
  @Test func cardFramesCanBeAskedFor() {
    let before = dl_fake_card_frames_alive()
    let log = LogLines()
    let port = refusingPort(NumberedSource(), log: log, cardFrames: true, refuses: false)
    #expect(port.open(videoMode: nil) == .running(mode: "16x4 at 59.94 on a software clock", frames: .card))
    port.fakeTick(4)
    #expect(port.fakeShown() == [0, 1, 2, 3, 4])
    #expect(log.lines == ["SDI test: opened in 16x4 at 59.94 on a software clock with the card's frames"])
    port.close()
    #expect(dl_fake_card_frames_alive() == before)
  }

  @Test func aCardThatTakesTheHelpersFramesMakesNone() {
    let before = dl_fake_card_frames_alive()
    let port = refusingPort(NumberedSource(), log: LogLines(), refuses: false)
    defer { port.close() }
    #expect(port.open(videoMode: nil) == .running(mode: "16x4 at 59.94 on a software clock", frames: .helper))
    port.fakeTick(4)
    #expect(port.fakeShown() == [0, 1, 2, 3, 4])
    #expect(dl_fake_card_frames_alive() == before)
  }
}
