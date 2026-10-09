import Foundation
import StageUtilityOutputCore
import Testing
@testable import DeckLinkKit

/// A source that writes each frame's index at the start of every line, so the
/// software clock's record of what went out says which picture each slot carried
/// (and that the whole frame carried it), and has nothing new for the frames in
/// `missing`. It records the order it is asked to begin and to fill frames in
/// ("b2", "f2"), and stamps each picture as drawn `drawnBeforeAir` before its
/// slot on the software clock's own time (slot n at n frame durations).
final class NumberedSource: CardFrameSource {
  private let lock = NSLock()
  private let missing: Set<Int64>
  private var _asked: [Int64] = []
  private var _events: [String] = []
  private var _missingNow = false
  private let drawnBeforeAirNs: Double?

  init(missing: Set<Int64> = [], drawnBeforeAirMs: Double? = nil) {
    self.missing = missing
    drawnBeforeAirNs = drawnBeforeAirMs.map { $0 * 1e6 }
  }

  var asked: [Int64] { lock.withLock { _asked } }
  var events: [String] { lock.withLock { _events } }
  /// While set, every frame has nothing new: a page that has stopped drawing.
  var missingNow: Bool {
    get { lock.withLock { _missingNow } }
    set { lock.withLock { _missingNow = newValue } }
  }

  func begin(_ request: CardFrameRequest) { lock.withLock { _events.append("b\(request.index)") } }

  func fill(_ request: CardFrameRequest, into target: CardFrameTarget) -> CardPicture? {
    lock.withLock {
      _asked.append(request.index)
      _events.append("f\(request.index)")
    }
    if missingNow || missing.contains(request.index) { return nil }
    for line in 0..<target.height {
      target.bytes.storeBytes(of: request.index.littleEndian, toByteOffset: line * target.rowBytes, as: Int64.self)
    }
    guard let before = drawnBeforeAirNs else { return .untimed }
    return CardPicture(contentNs: UInt64(max(0, request.seconds * 1e9 - before)))
  }
}

final class LogLines {
  private let lock = NSLock()
  private var _lines: [String] = []
  var lines: [String] { lock.withLock { _lines } }
  func write(_ level: DeckLinkLog.Level, _ message: String) { lock.withLock { _lines.append(message) } }
}

/// 59.94 on a clock that only the test moves, at a frame small enough to be quick.
func softwarePort(
  _ source: CardFrameSource, log: LogLines = LogLines(), leads: CardLeads = .standard, minLeadMs: Double = 0,
  clock: @escaping () -> TimeInterval = { 0 }
) -> DeckLinkOutputPort {
  DeckLinkOutputPort(
    label: "SDI test",
    hardware: .softwareClock(
      width: 16, height: 4, frameDuration: 1001, timeScale: 60000, ticksByItself: false, minLeadMs: minLeadMs),
    source: source, leads: leads, retryInterval: 3600, pollInterval: 3600, log: log.write, clock: clock)
}

let softwareMode = DeckLinkOutputPort.State.running(mode: "16x4 at 59.94 on a software clock", frames: .card)

@Suite struct OutputPortTests {
  /// The source has nothing new for frames 5, 9 and 10: exactly those three go out
  /// as repeats, each carrying the picture before it. A frame's memory last held
  /// the picture of three frames earlier, so a repeat that is not copied in steps
  /// the picture backwards.
  @Test func aLateSourceGetsExactlyThoseFramesRepeated() {
    let source = NumberedSource(missing: [5, 9, 10])
    let port = softwarePort(source)
    defer { port.close() }
    #expect(port.open(videoMode: nil) == softwareMode)

    port.fakeTick(20)

    let counts = port.counters
    #expect(counts.repeated == 3)
    #expect(counts.dropped == 0)
    #expect(counts.resyncs == 0)
    #expect(counts.scheduled == 21)  // two of pre-roll, then one per slot as its fill comes due
    #expect(counts.rendered == 18)
    #expect(source.asked == Array(0...20))
    #expect(port.fakeShown() == [0, 1, 2, 3, 4, 4, 6, 7, 8, 8, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  }

  /// Each slot is begun the head start before it goes to air and filled the fill
  /// lead before, both on the card's clock: with the standard 20 and 5 ms at 59.94
  /// (16.68 ms a slot), slot n is begun 3.3 ms before slot n - 1 begins, after
  /// slot n - 1 was filled, and filled 5 ms before its own. A short head start
  /// begins a slot after the one before it has gone to air. The pre-roll (0 and 1)
  /// is filled before the clock runs and never begun.
  @Test func eachSlotIsBegunAndFilledAtItsLeadsBeforeAir() {
    let standard = NumberedSource()
    let port = softwarePort(standard)
    port.open(videoMode: nil)
    port.fakeTick(4)
    port.close()
    #expect(standard.events == ["f0", "f1", "b2", "f2", "b3", "f3", "b4", "f4", "b5"])

    let short = NumberedSource()
    let late = softwarePort(short, leads: CardLeads(headStartMs: 10, fillLeadMs: 5))
    late.open(videoMode: nil)
    late.fakeTick(4)
    late.close()
    #expect(short.events == ["f0", "f1", "b2", "f2", "b3", "f3", "b4", "f4"])
  }

  /// The card's frames are held up for eight slots (its completions do not come),
  /// while its clock runs on. The output cannot fill a frame the card still holds,
  /// so it skips those slots, the card holding its last picture, and is filling
  /// every slot on time again as soon as the frames come back: none dropped by
  /// the card, no delay left behind. The skipped slots are one resync, and the
  /// health post reports them as dropped: they went out with no frame of ours.
  @Test func framesTheCardHoldsOnToAreSkippedNotSentLate() {
    let source = NumberedSource()
    let port = softwarePort(source)
    defer { port.close() }
    port.open(videoMode: nil)

    port.fakeTick(10)
    port.fakeHold(true)
    port.fakeTick(10)
    port.fakeHold(false)
    port.fakeTick(30)

    let counts = port.counters
    #expect(counts.resyncs == 1)
    #expect(counts.dropped == 0)
    #expect(counts.skipped == 8)
    let skipped = port.timingsForTest().filter(\.skipped)
    #expect(skipped.map(\.index) == Array(13...20))
    #expect(skipped.allSatisfy { $0.result == 1 })  // every frame was still with the card
    #expect(port.takeHealthSample().dropped == 8)
    let shown = port.fakeShown()
    #expect(shown.count == 51)
    // On time until the frames run out; the card holds frame 12 through the slots
    // nobody could fill; from slot 21 every slot carries its own frame.
    #expect(Array(shown[0...12]) == Array(0...12))
    #expect(Array(shown[13...20]) == Array(repeating: 12, count: 8))
    #expect(Array(shown[21...50]) == Array(21...50))
  }

  /// A card that needs a frame longer before its slot than the fill lead gives
  /// would show every frame late: each slot is skipped instead, and the card holds
  /// the pre-roll. A fill that cannot make it is never sent.
  @Test func aFillTooLateForTheCardIsSkippedNotSent() {
    let source = NumberedSource()
    let port = softwarePort(source, minLeadMs: 6)
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(10)
    let counts = port.counters
    #expect(counts.scheduled == 2)
    #expect(counts.skipped == 9)
    #expect(counts.resyncs == 1)
    #expect(counts.dropped == 0)
    #expect(port.fakeShown() == [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    #expect(source.asked == [0, 1])
    #expect(port.timingsForTest().filter(\.skipped).allSatisfy { $0.result == 0 })  // too late, not short of frames
  }

  /// Frames the card reports displayed late are counted as dropped.
  @Test func framesTheCardReportsLateAreCountedDropped() {
    let port = softwarePort(NumberedSource())
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeReportLate(2)
    port.fakeTick(10)
    #expect(port.counters.dropped == 2)
    #expect(port.counters.repeated == 0)
  }

  /// A card that stops asking for frames without reporting anything is treated as
  /// lost after two quiet polls, so it is logged and reopened rather than left
  /// frozen and silent.
  @Test func aPortThatStopsTakingFramesIsLost() {
    let log = LogLines()
    let port = softwarePort(NumberedSource(), log: log)
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(3)
    port.pollForTest()
    port.pollForTest()  // nothing sent since the last poll: one quiet poll
    #expect(port.state == softwareMode)
    port.pollForTest()
    #expect(port.state == .lost("the card stopped taking frames"))
    #expect(log.lines.last == "SDI test: lost (the card stopped taking frames); trying again every 3600 s")
  }

  // Not unit-tested: that the clock thread wakes when it asks to. A software clock
  // only tests move runs every begin and fill at its exact time; on a card it is a
  // real-time thread's wake, which was measured instead (DECKLINK.md, "Timing":
  // within 35 us, against 1.4 ms late at user-interactive priority).

  // Not unit-tested: that a loss reported on the card's thread never takes a strong
  // reference to the port there (CallbackBox). The failure is a race between the
  // owner dropping the port and a loss arriving, which no test here can line up
  // deterministically; the thunk only enqueues onto the port's queue, by reading.

  @Test func anUnpluggedPortIsLostAndReopens() {
    let log = LogLines()
    let port = softwarePort(NumberedSource(), log: log)
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(5)

    port.fakeUnplug()
    port.sync()
    #expect(port.state == .lost("the device was removed"))
    #expect(port.counters.scheduled == 6)
    port.fakeTick(5)  // nothing to tick: the output is closed
    #expect(port.counters.scheduled == 6)

    port.retry()
    port.sync()
    #expect(port.state == softwareMode)
    #expect(port.counters.scheduled == 8)  // the count runs on across the reopening
    #expect(
      log.lines == [
        "SDI test: opened in 16x4 at 59.94 on a software clock",
        "SDI test: lost (the device was removed); trying again every 3600 s",
        "SDI test: reopened in 16x4 at 59.94 on a software clock",
      ])
  }

  /// A reopening says the leads as the first opening did, when they are not the
  /// standard ones: the log is where a run's settings are read back from.
  @Test func aReopenedPortSaysItsLeads() {
    let log = LogLines()
    let port = softwarePort(NumberedSource(), log: log, leads: CardLeads(headStartMs: 16, fillLeadMs: 4))
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeUnplug()
    port.sync()
    port.retry()
    port.sync()
    #expect(
      log.lines == [
        "SDI test: opened in 16x4 at 59.94 on a software clock; pictures asked for 16 ms and filled 4 ms before air",
        "SDI test: lost (the device was removed); trying again every 3600 s",
        "SDI test: reopened in 16x4 at 59.94 on a software clock; pictures asked for 16 ms and filled 4 ms before air",
      ])
  }

  /// A port says each time it opens, the first time and on every retry, with its
  /// frame size: the cue for its page to lay out. An open that fails says nothing.
  @Test func aPortSaysEachTimeItOpensWithItsSize() {
    let port = softwarePort(NumberedSource())
    defer { port.close() }
    let opened = Locked<[PixelSize]>([])
    port.onOpened = { opened.value.append($0) }
    port.fakeRefuseOpens("the port is in use by another application")
    #expect(port.open(videoMode: nil) == .lost("the port is in use by another application"))
    #expect(opened.value.isEmpty)
    port.fakeRefuseOpens(nil)
    port.retry()
    port.sync()
    port.fakeUnplug()
    port.sync()
    port.retry()
    port.sync()
    #expect(opened.value == [PixelSize(width: 16, height: 4), PixelSize(width: 16, height: 4)])
  }

  static let p50 = CardMode(
    code: 0x4870_3530, driverName: "1080p50", width: 1920, height: 1080, frameDuration: 1000, timeScale: 50000,
    field: .progressive, supportsYUV8: true)
  static let p5994 = CardMode(
    code: 0x4870_3539, driverName: "1080p59.94", width: 1920, height: 1080, frameDuration: 1001,
    timeScale: 60000, field: .progressive, supportsYUV8: true)

  func cardPort(_ modes: [CardMode], log: LogLines) -> DeckLinkOutputPort {
    let port = DeckLinkPort(
      id: DeckLinkPortID(persistentID: 0x1234, subDevice: 0), displayName: "DeckLink Duo (1)", modelName: "",
      modes: modes)
    return DeckLinkOutputPort(
      label: "DeckLink Duo (1)", hardware: .port(port), source: NumberedSource(), retryInterval: 3600,
      log: log.write)
  }

  @Test func aModeThePortLacksIsRefusedWithoutTouchingTheCard() {
    let log = LogLines()
    let port = cardPort([Self.p50], log: log)
    defer { port.close() }
    #expect(port.open(videoMode: nil) == .refused("the port has no 1080p59.94 (it offers 1080p50)"))
    #expect(log.lines == ["DeckLink Duo (1): refused 1080p59.94: the port has no 1080p59.94 (it offers 1080p50)"])
  }

  /// A port that is not there (no driver on this Mac, or no card with that id) has
  /// its mode resolved, fails to open, and waits to try again, as a card not
  /// plugged in yet would.
  @Test func aPortThatCannotOpenIsLostAndRetried() throws {
    let why = DriverTests.installed ? "the port is not connected" : "Desktop Video is not installed"
    let log = LogLines()
    let port = cardPort([Self.p5994], log: log)
    defer { port.close() }
    #expect(port.open(videoMode: "1080p59.94") == .lost(why))
    #expect(log.lines == ["DeckLink Duo (1): could not open (\(why)); trying again every 3600 s"])
    port.retry()
    port.sync()
    #expect(port.state == .lost(why))
    #expect(log.lines.count == 1)  // a retry that fails again says nothing more
  }

  /// In the server's units (output-health.ts): fps is frames sent per second,
  /// repeated is a PERCENT of the window's frames, dropped a TOTAL since the
  /// output was made, which the next window does not start over.
  @Test func theHealthSampleIsInTheServersUnits() {
    let now = Locked(0.0)
    let port = softwarePort(NumberedSource(missing: [4, 5, 6]), clock: { now.value })
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeReportLate(2)
    port.fakeTick(59)
    now.value = 1.0
    // 60 sent in a second: two of pre-roll and 58 filled as they came due. 3 of 60
    // is 5%. Nothing said when its pictures were drawn, so no latency.
    #expect(port.takeHealthSample() == HealthSample(fps: 60, repeated: 5, dropped: 2))
    port.fakeTick(30)
    now.value = 1.5
    #expect(port.takeHealthSample() == HealthSample(fps: 60, repeated: 0, dropped: 2))
  }

  /// The health sample's latency is the median, over the window's new pictures, from
  /// each picture being drawn to its slot going out of the card, as the shim timed
  /// it on the card's clock: here every picture is drawn 18 ms before its slot.
  /// Repeats carry the time of the picture they repeat, older with every slot,
  /// so they are left out: here more than half the window repeats.
  @Test func theHealthSampleCarriesTheRenderToAirLatency() throws {
    let port = softwarePort(NumberedSource(missing: Set(10...25), drawnBeforeAirMs: 18))
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(30)
    let latency = try #require(port.takeHealthSample().latencyMs)
    #expect(abs(latency - 18) < 0.001)
    port.fakeTick(10)
    let timings = port.timingsForTest()
    #expect(timings.map(\.index) == Array(30...39))  // the slots the card has finished with since the sample
    for t in timings {
      #expect(t.fresh && !t.skipped)
      let air = Double(t.index) * 1001 / 60000 * 1e9
      #expect(abs(Double(t.airNs) - air) < 2)
      #expect(abs(Double(t.fillNs) - (air - 5e6)) < 2)
      #expect(t.renderToAirMs.map { abs($0 - 18) < 0.001 } == true)
    }
  }

  /// A frame the card showed late or dropped did not go out when its time says,
  /// so it is left out of the latency: 28 new pictures timed, 2 of them late.
  @Test func framesShownLateAreLeftOutOfTheLatency() {
    let log = LogLines()
    let port = softwarePort(NumberedSource(drawnBeforeAirMs: 18), log: log)
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(5)
    port.fakeReportLate(2)  // frames 5 and 6
    port.fakeTick(25)
    _ = port.takeHealthSample()
    #expect(log.lines.last?.hasSuffix("over 26 new pictures") == true, "\(log.lines)")
  }

  /// A card that cannot say where its playback is leaves nothing to time a slot
  /// by. The clock thread asks again every millisecond rather than spinning, and
  /// the port says why it sends nothing.
  @Test func aCardThatCannotSayWhereItIsIsAskedEveryMillisecond() async throws {
    let log = LogLines()
    let port = DeckLinkOutputPort(
      label: "SDI test",
      hardware: .softwareClock(
        width: 16, height: 4, frameDuration: 1001, timeScale: 60000, ticksByItself: true, clockUnknown: true),
      source: NumberedSource(), retryInterval: 3600, pollInterval: 3600, log: log.write)
    defer { port.close() }
    port.open(videoMode: nil)
    try await Task.sleep(nanoseconds: 200_000_000)
    let reads = port.fakeClockReads()
    #expect(reads > 20 && reads < 1_000, "\(reads) reads in 200 ms")
    port.pollForTest()
    #expect(log.lines.contains("SDI test: the card would not say where its playback is, so no frame could be timed"))
  }

  /// A head start no longer than the fill lead leaves the page no time at all:
  /// the open is refused and says why.
  @Test func aHeadStartNoLongerThanTheFillLeadIsRefused() {
    let port = softwarePort(NumberedSource(), leads: CardLeads(headStartMs: 5, fillLeadMs: 5))
    defer { port.close() }
    #expect(
      port.open(videoMode: nil)
        == .lost("the head start is not longer than the fill lead, so no picture could be ready in time"))
  }

  @Test func aNewPortStartsTheDropTotalAtNothing() {
    let port = softwarePort(NumberedSource())
    defer { port.close() }
    port.open(videoMode: nil)
    #expect(port.takeHealthSample().dropped == 0)
  }

  /// The server's line, per second: 5% of the frames sent repeated (3 of 60 at
  /// 59.94) or any drop is falling behind; five clean seconds in a row is keeping up
  /// again. Two repeats is jitter and says nothing.
  @Test func fallingBehindIsLoggedWhenItStartsAndWhenItEnds() {
    let log = LogLines()
    // Sixty slots a poll, as a second at 59.94: the first poll covers slots 0 to 60,
    // each one after the next sixty. 70 and 71 are two repeats in the second poll's
    // second, 200 to 202 three in the fourth's.
    let port = softwarePort(NumberedSource(missing: [70, 71, 200, 201, 202]), log: log)
    defer { port.close() }
    port.open(videoMode: nil)
    for _ in 0..<12 {
      port.fakeTick(60)
      port.pollForTest()
    }
    #expect(
      log.lines == [
        "SDI test: opened in 16x4 at 59.94 on a software clock",
        "SDI test: falling behind: 3 repeated and 0 dropped in the last second",
        "SDI test: keeping up again after 6 s",
      ])
  }

  /// A drop alone is falling behind.
  @Test func aDropAloneIsFallingBehind() {
    let log = LogLines()
    let port = softwarePort(NumberedSource(), log: log)
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(10)
    port.pollForTest()
    port.fakeReportLate(1)
    port.fakeTick(10)
    port.pollForTest()
    #expect(log.lines.last == "SDI test: falling behind: 0 repeated and 1 dropped in the last second")
  }

  /// The pre-roll of a reopening repeats by necessity: it is the baseline, not
  /// falling behind. The second after the reopening has two genuine repeats of 60,
  /// 3.3%, jitter; counted with the pre-roll's two it would be 4 of 62, 6.5%, over
  /// the server's 5%.
  @Test func aReopeningsPreRollIsNotFallingBehind() {
    let log = LogLines()
    let source = NumberedSource(missing: [30, 31])
    let port = softwarePort(source, log: log)
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(60)
    port.pollForTest()  // the first second drawn in: not judged
    source.missingNow = true
    port.open(videoMode: nil)  // a pre-roll of two repeats
    source.missingNow = false
    port.fakeTick(60)
    port.pollForTest()
    #expect(port.counters.repeated == 2 + 2 + 2)  // 30 and 31 in each second, and the pre-roll
    #expect(!log.lines.contains { $0.contains("falling behind") }, "\(log.lines)")
  }

  /// A source with no new picture for five polls in a row is reported once, so its
  /// owner reloads the page once, not every second after.
  @Test func aSourceThatStopsDrawingIsReportedOnce() {
    let source = NumberedSource()
    let port = softwarePort(source)
    defer { port.close() }
    let stalls = Locked(0)
    port.onSourceStalled = { stalls.value += 1 }
    port.open(videoMode: nil)
    port.fakeTick(10)
    port.pollForTest()
    source.missingNow = true
    for _ in 0..<(CardWatch.stallSeconds * 3) {
      port.fakeTick(10)
      port.pollForTest()
    }
    #expect(stalls.value == 1)
  }

  /// A running port whose page has never drawn sends its black pre-roll at the full
  /// rate: it says so in the log and its status, and health reports every frame
  /// repeated. It says so again when the page draws.
  @Test func aRunningPortWhosePageNeverDrawsSaysSo() {
    let log = LogLines()
    let source = NumberedSource()
    source.missingNow = true
    let port = softwarePort(source, log: log)
    defer { port.close() }
    port.open(videoMode: nil)
    for _ in 0..<CardWatch.noPictureSeconds {
      port.fakeTick(60)
      port.pollForTest()
    }
    #expect(port.status.silence == .neverDrawn)
    #expect(port.takeHealthSample().repeated == 100)
    source.missingNow = false
    port.fakeTick(60)
    port.pollForTest()
    #expect(port.status.silence == nil)
    #expect(
      log.lines == [
        "SDI test: opened in 16x4 at 59.94 on a software clock",
        "SDI test: no picture from the page in 10 s of sending, so the card is sending black",
        "SDI test: pictures from the page again",
      ])
  }

  /// A port tells its owner each time its status changes, so the window says so
  /// then, without asking the port's queue: opened, lost, opened again, and its page
  /// silent and drawing again. Nothing is said twice.
  @Test func aPortSaysEachChangeOfItsStatus() {
    let source = NumberedSource()
    let port = softwarePort(source)
    let said = Locked<[DeckLinkOutputPort.Status]>([])
    port.onStatus = { said.value.append($0) }
    let running = DeckLinkOutputPort.Status(state: softwareMode, silence: nil)
    port.open(videoMode: nil)
    port.fakeTick(60)
    port.pollForTest()
    port.fakeUnplug()
    port.sync()
    port.retry()
    port.sync()
    source.missingNow = true
    for _ in 0...CardWatch.stallSeconds {
      port.fakeTick(60)
      port.pollForTest()
    }
    source.missingNow = false
    port.fakeTick(60)
    port.pollForTest()
    port.close()
    #expect(
      said.value == [
        running,
        DeckLinkOutputPort.Status(state: .lost("the device was removed"), silence: nil),
        running,
        DeckLinkOutputPort.Status(state: softwareMode, silence: .stopped),
        running,
        DeckLinkOutputPort.Status(state: .closed, silence: nil),
      ])
  }

  /// A virtual port opens in whichever of the server's modes it is asked for, at
  /// that mode's size, and refuses a name the server does not list.
  @Test func aVirtualPortTakesAnyListedMode() {
    let log = LogLines()
    let port = DeckLinkOutputPort(
      label: "SDI 2 (virtual)", hardware: .virtual, source: NumberedSource(), retryInterval: 3600, pollInterval: 3600,
      log: log.write)
    defer { port.close() }
    #expect(port.open(videoMode: nil) == .running(mode: "1080p59.94 on a software clock", frames: .card))
    #expect(port.frameSize == PixelSize(width: 1920, height: 1080))
    #expect(port.open(videoMode: "720p59.94") == .running(mode: "720p59.94 on a software clock", frames: .card))
    #expect(port.frameSize == PixelSize(width: 1280, height: 720))
    #expect(port.open(videoMode: "4Kp60") == .refused("4Kp60 is not a mode the helper knows"))
    #expect(
      log.lines == [
        "SDI 2 (virtual): opened in 1080p59.94 on a software clock",
        "SDI 2 (virtual): opened in 720p59.94 on a software clock",
        "SDI 2 (virtual): refused 4Kp60: 4Kp60 is not a mode the helper knows",
      ])
  }

  /// The software clock ticking by itself, as a virtual output's does: frames go out
  /// with nobody moving the clock.
  @Test func theSoftwareClockRunsByItself() async throws {
    let port = DeckLinkOutputPort(
      label: "null",
      hardware: .softwareClock(width: 16, height: 4, frameDuration: 1001, timeScale: 60000, ticksByItself: true),
      source: NumberedSource(), retryInterval: 3600, pollInterval: 3600, log: LogLines().write)
    port.open(videoMode: nil)
    try await Task.sleep(nanoseconds: 300_000_000)
    port.close()
    let counts = port.counters
    #expect(counts.scheduled > 6)
    #expect(counts.repeated == 0)
    #expect(counts.dropped == 0)
  }
}

final class Locked<T> {
  private let lock = NSLock()
  private var _value: T
  init(_ value: T) { _value = value }
  var value: T {
    get { lock.withLock { _value } }
    set { lock.withLock { _value = newValue } }
  }
}
