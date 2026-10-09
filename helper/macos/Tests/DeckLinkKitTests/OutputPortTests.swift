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

  init(missing: Set<Int64> = []) { self.missing = missing }

  var asked: [Int64] { lock.withLock { _asked } }

  func fill(_ request: CardFrameRequest, into target: CardFrameTarget) -> Bool {
    lock.withLock { _asked.append(request.index) }
    if missing.contains(request.index) { return false }
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
  /// carries its own frame again: no frames dropped, no delay left behind.
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

  /// With no driver the port's mode resolves, the open fails, and the port waits
  /// to try again, as it would for a card that is not plugged in yet.
  @Test func aPortThatCannotOpenIsLostAndRetried() throws {
    try #require(!FileManager.default.fileExists(atPath: DriverTests.framework), "Desktop Video is installed here")
    let log = LogLines()
    let port = cardPort([Self.p5994], log: log)
    defer { port.close() }
    #expect(port.open(videoMode: "1080p59.94") == .lost("Desktop Video is not installed"))
    #expect(
      log.lines == [
        "DeckLink Duo (1): could not open (Desktop Video is not installed); trying again every 3600 s"
      ])
    port.retry()
    port.sync()
    #expect(port.state == .lost("Desktop Video is not installed"))
    #expect(log.lines.count == 1)  // a retry that fails again says nothing more
  }

  @Test func theHealthSampleIsTheCountsSinceTheLastOne() {
    let now = Locked(0.0)
    let port = softwarePort(NumberedSource(missing: [4, 5]), clock: { now.value })
    defer { port.close() }
    port.open(videoMode: nil)
    port.fakeTick(57)
    now.value = 1.0
    // 60 sent in a second: three of pre-roll and 57 rescheduled.
    #expect(port.takeHealthSample() == HealthSample(fps: 60, repeated: 2, dropped: 0))
    port.fakeTick(30)
    now.value = 1.5
    #expect(port.takeHealthSample() == HealthSample(fps: 60, repeated: 0, dropped: 0))
  }

  @Test func repeatsAreLoggedWhenTheyStartAndWhenTheyStop() {
    let log = LogLines()
    let port = softwarePort(NumberedSource(missing: [10, 11, 12]), log: log)
    defer { port.close() }
    port.open(videoMode: nil)
    for _ in 0..<8 {
      port.fakeTick(5)
      port.pollForTest()
    }
    #expect(
      log.lines == [
        "SDI test: opened in 16x4 at 59.94 on a software clock",
        "SDI test: repeating frames (3 in the last 3600 s)",
        "SDI test: stopped repeating frames (3 in all)",
      ])
  }

  /// The software clock ticking by itself, as the null sink does: frames go out
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
