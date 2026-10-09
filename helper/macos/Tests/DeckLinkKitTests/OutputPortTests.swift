import Foundation
import StageUtilityOutputCore
import Testing
@testable import DeckLinkKit

/// A source that writes each frame's index at the start of every line, so the
/// software clock's record of what went out says which picture each slot carried
/// (and that the whole frame carried it), and has nothing new for the frames in
/// `missing`.
final class NumberedSource: CardFrameSource {
  private let lock = NSLock()
  private let missing: Set<Int64>
  private var _asked: [Int64] = []
  private var _missingNow = false

  init(missing: Set<Int64> = []) { self.missing = missing }

  var asked: [Int64] { lock.withLock { _asked } }
  /// While set, every frame has nothing new: a page that has stopped drawing.
  var missingNow: Bool {
    get { lock.withLock { _missingNow } }
    set { lock.withLock { _missingNow = newValue } }
  }

  func fill(_ request: CardFrameRequest, into target: CardFrameTarget) -> Bool {
    lock.withLock { _asked.append(request.index) }
    if missingNow || missing.contains(request.index) { return false }
    for line in 0..<target.height {
      target.bytes.storeBytes(of: request.index.littleEndian, toByteOffset: line * target.rowBytes, as: Int64.self)
    }
    return true
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
  _ source: CardFrameSource, log: LogLines = LogLines(), clock: @escaping () -> TimeInterval = { 0 }
) -> DeckLinkOutputPort {
  DeckLinkOutputPort(
    label: "SDI test",
    hardware: .softwareClock(width: 16, height: 4, frameDuration: 1001, timeScale: 60000, ticksByItself: false),
    source: source, retryInterval: 3600, pollInterval: 3600, log: log.write, clock: clock)
}

@Suite struct OutputPortTests {
  /// The source has nothing new for frames 5, 9 and 10: exactly those three go out
  /// as repeats, each carrying the picture before it. A frame's memory last held
  /// the picture of three frames earlier, so a repeat that is not copied in steps
  /// the picture backwards.
  @Test func aLateSourceGetsExactlyThoseFramesRepeated() {
    let source = NumberedSource(missing: [5, 9, 10])
    let port = softwarePort(source)
    defer { port.close() }
    #expect(port.open(videoMode: nil) == .running(mode: "16x4 at 59.94 on a software clock", frames: .helper))

    port.fakeTick(20)

    let counts = port.counters
    #expect(counts.repeated == 3)
    #expect(counts.dropped == 0)
    #expect(counts.resyncs == 0)
    #expect(counts.scheduled == 23)  // three of pre-roll, one per completed frame
    #expect(counts.rendered == 20)
    #expect(source.asked == Array(0...22))
    #expect(port.fakeShown() == [0, 1, 2, 3, 4, 4, 6, 7, 8, 8, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  }

  /// The host is held up for ten frames while the card's clock runs on. The
  /// schedule is moved to just ahead of the card once, and from then on each slot
  /// carries its own frame again: none dropped by the card, no delay left behind.
  /// The nine slots the move passed over are counted as skipped, and the health
  /// post reports them as dropped: they went out with no frame of ours.
  ///
  /// Without the move the frames after the stall are scheduled in the past. The
  /// software clock drops those (eleven here, and the picture holds for two more
  /// slots) until the schedule has caught up; a card that shows a late frame
  /// instead of dropping it would carry the delay from then on.
  @Test func aStalledHostResyncsInsteadOfFallingBehind() {
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
    #expect(counts.skipped == 9)
    #expect(port.takeHealthSample().dropped == 9)
    let shown = port.fakeShown()
    #expect(shown.count == 51)
    // On time up to the stall; the card holds frame 12 through the slots nobody
    // filled; from slot 22 every slot carries its own frame.
    #expect(Array(shown[0...12]) == Array(0...12))
    #expect(Array(shown[13...21]) == Array(repeating: 12, count: 9))
    #expect(Array(shown[22...50]) == Array(22...50))
  }

  /// The host is held up for exactly the frames in flight, so the next frame would
  /// go out in the very slot on air: too late, and moved like any later one.
  @Test func aScheduleThatWouldLandOnTheFrameOnAirResyncs() {
    let port = softwarePort(NumberedSource())
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(5)
    port.fakeHold(true)
    port.fakeTick(3)
    port.fakeHold(false)
    port.fakeTick(10)
    #expect(port.counters.resyncs == 1)
    #expect(port.counters.dropped == 0)
    #expect(port.counters.skipped == 2)  // the slot on air and the one after it
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
    #expect(port.state == .running(mode: "16x4 at 59.94 on a software clock", frames: .helper))
    port.pollForTest()
    #expect(port.state == .lost("the card stopped taking frames"))
    #expect(log.lines.last == "SDI test: lost (the card stopped taking frames); trying again every 3600 s")
  }

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
    #expect(port.counters.scheduled == 8)
    port.fakeTick(5)  // nothing to tick: the output is closed
    #expect(port.counters.scheduled == 8)

    port.retry()
    port.sync()
    #expect(port.state == .running(mode: "16x4 at 59.94 on a software clock", frames: .helper))
    #expect(port.counters.scheduled == 11)  // the count runs on across the reopening
    #expect(
      log.lines == [
        "SDI test: opened in 16x4 at 59.94 on a software clock",
        "SDI test: lost (the device was removed); trying again every 3600 s",
        "SDI test: reopened in 16x4 at 59.94 on a software clock",
      ])
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
    port.fakeTick(57)
    now.value = 1.0
    // 60 sent in a second: three of pre-roll and 57 rescheduled. 3 of 60 is 5%.
    #expect(port.takeHealthSample() == HealthSample(fps: 60, repeated: 5, dropped: 2))
    port.fakeTick(30)
    now.value = 1.5
    #expect(port.takeHealthSample() == HealthSample(fps: 60, repeated: 0, dropped: 2))
  }

  @Test func aNewPortStartsTheDropTotalAtNothing() {
    let port = softwarePort(NumberedSource())
    defer { port.close() }
    port.open(videoMode: nil)
    #expect(port.takeHealthSample().dropped == 0)
  }

  /// The server's line, per second: 3 repeats (5% of 59.94) or any drop is
  /// falling behind; five clean seconds in a row is keeping up again. Two repeats
  /// is jitter and says nothing.
  @Test func fallingBehindIsLoggedWhenItStartsAndWhenItEnds() {
    let log = LogLines()
    let port = softwarePort(NumberedSource(missing: [20, 21, 40, 41, 42]), log: log)
    defer { port.close() }
    port.open(videoMode: nil)
    for _ in 0..<12 {
      port.fakeTick(10)
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
  /// falling behind.
  @Test func aReopeningsPreRollIsNotFallingBehind() {
    let log = LogLines()
    let source = NumberedSource()
    let port = softwarePort(source, log: log)
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(10)
    port.pollForTest()
    source.missingNow = true
    port.open(videoMode: nil)
    source.missingNow = false
    port.fakeTick(10)
    port.pollForTest()
    #expect(!log.lines.contains { $0.contains("falling behind") })
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

  /// A virtual port opens in whichever of the server's modes it is asked for, at
  /// that mode's size, and refuses a name the server does not list.
  @Test func aVirtualPortTakesAnyListedMode() {
    let log = LogLines()
    let port = DeckLinkOutputPort(
      label: "SDI 2 (virtual)", hardware: .virtual, source: NumberedSource(), retryInterval: 3600, pollInterval: 3600,
      log: log.write)
    defer { port.close() }
    #expect(port.open(videoMode: nil) == .running(mode: "1080p59.94 on a software clock", frames: .helper))
    #expect(port.frameSize.map { [$0.width, $0.height] } == [1920, 1080])
    #expect(port.open(videoMode: "720p59.94") == .running(mode: "720p59.94 on a software clock", frames: .helper))
    #expect(port.frameSize.map { [$0.width, $0.height] } == [1280, 720])
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
