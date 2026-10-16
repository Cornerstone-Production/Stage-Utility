import DeckLinkShim
import Foundation
import Testing
@testable import DeckLinkKit

/// Serialized: the count of frames the software clocks have made is one number for
/// the whole process, and only these tests' clocks are counted.
@Suite(.serialized) struct CardFramesTests {
  /// `frames` nil is the port's own default, the card's frames.
  func fakePort(
    _ source: CardFrameSource, log: LogLines, frames: DeckLinkOutputPort.Frames? = nil, refuses: Bool = false,
    makesNoFrames: Bool = false
  ) -> DeckLinkOutputPort {
    let hardware = DeckLinkOutputPort.Hardware.softwareClock(
      width: 16, height: 4, frameDuration: 1001, timeScale: 60000, ticksByItself: false,
      refusesHelperFrames: refuses, makesNoFrames: makesNoFrames, countsFrames: true)
    return DeckLinkOutputPort(
      label: "SDI test", hardware: hardware, source: source, frames: frames ?? .card, retryInterval: 3600,
      pollInterval: 3600, log: log.write)
  }

  /// The card's frames are what a port asks for, and the pictures go straight into
  /// them: frames flow whole although the card's lines are longer than the
  /// picture's (a copy that ignored that would tear them). Closing frees every
  /// frame the card made.
  @Test func theCardsFramesAreTheDefault() {
    let before = dl_fake_card_frames_alive()
    let log = LogLines()
    let port = fakePort(NumberedSource(missing: [5]), log: log)
    #expect(port.open(videoMode: nil) == .running(mode: "16x4 at 59.94 on a software clock", frames: .card))
    #expect(dl_fake_card_frames_alive() - before == 3)
    port.fakeTick(10)
    #expect(port.counters.scheduled == 11)
    #expect(port.counters.repeated == 1)
    #expect(port.fakeShown() == [0, 1, 2, 3, 4, 4, 6, 7, 8, 9, 10])
    #expect(log.lines == ["SDI test: opened in 16x4 at 59.94 on a software clock"])
    port.close()
    #expect(dl_fake_card_frames_alive() == before)
  }

  /// A card that will not make frames gets the helper's by itself, says so once,
  /// and keeps them across a reopening.
  @Test func aCardThatMakesNoFramesGetsTheHelpers() {
    let before = dl_fake_card_frames_alive()
    let log = LogLines()
    let port = fakePort(NumberedSource(), log: log, makesNoFrames: true)
    #expect(port.open(videoMode: nil) == .running(mode: "16x4 at 59.94 on a software clock", frames: .helper))
    port.fakeTick(4)
    #expect(port.fakeShown() == [0, 1, 2, 3, 4])
    port.fakeUnplug()
    port.sync()
    port.retry()
    port.sync()
    #expect(port.frames == .helper)
    #expect(
      log.lines == [
        "SDI test: the card would not make frames of its own, so it gets the helper's frames",
        "SDI test: opened in 16x4 at 59.94 on a software clock with the helper's frames",
        "SDI test: lost (the device was removed); trying again every 3600 s",
        "SDI test: reopened in 16x4 at 59.94 on a software clock with the helper's frames",
      ])
    port.close()
    #expect(dl_fake_card_frames_alive() == before)
  }

  /// Asked for the helper's frames, a card that refuses them at the pre-roll gets
  /// its own by itself, and says so once.
  @Test func aCardThatRefusesTheHelpersFramesGetsItsOwn() {
    let before = dl_fake_card_frames_alive()
    let log = LogLines()
    let port = fakePort(NumberedSource(), log: log, frames: .helper, refuses: true)
    #expect(port.open(videoMode: nil) == .running(mode: "16x4 at 59.94 on a software clock", frames: .card))
    port.fakeTick(4)
    #expect(port.fakeShown() == [0, 1, 2, 3, 4])
    #expect(
      log.lines == [
        "SDI test: the card refused the helper's own frames, so it gets the card's frames",
        "SDI test: opened in 16x4 at 59.94 on a software clock",
      ])
    port.close()
    #expect(dl_fake_card_frames_alive() == before)
  }

  /// A card that will take neither kind is tried once in each and refused: the open
  /// returns, rather than switching back and forth for ever. Opened on another
  /// thread, so an open that never returns fails this test after 5 s instead of
  /// hanging the run (the time limit of a test cannot stop a loop that never waits).
  @Test func aCardThatTakesNeitherKindIsTriedOnceInEach() {
    let port = fakePort(NumberedSource(), log: LogLines(), refuses: true, makesNoFrames: true)
    let state = Locked<DeckLinkOutputPort.State?>(nil)
    let done = DispatchSemaphore(value: 0)
    Thread.detachNewThread {
      state.value = port.open(videoMode: nil)
      done.signal()
    }
    let returned = done.wait(timeout: .now() + 5) == .success
    #expect(returned, "the open did not return in 5 s")
    guard returned else { return }
    #expect(state.value == .lost("the card refused the helper's own frames"))
    port.close()
  }

  @Test func helperFramesOnACardThatTakesThemMakeNone() {
    let before = dl_fake_card_frames_alive()
    let port = fakePort(NumberedSource(), log: LogLines(), frames: .helper)
    defer { port.close() }
    #expect(port.open(videoMode: nil) == .running(mode: "16x4 at 59.94 on a software clock", frames: .helper))
    port.fakeTick(4)
    #expect(port.fakeShown() == [0, 1, 2, 3, 4])
    #expect(dl_fake_card_frames_alive() == before)
  }
}
