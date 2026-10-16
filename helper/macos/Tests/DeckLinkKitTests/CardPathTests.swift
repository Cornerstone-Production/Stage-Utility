import Foundation
import IOSurface
import StageUtilityOutputCore
import Testing
@testable import DeckLinkKit

/// A virtual card output end to end, with no browser: a picture presented as an
/// IOSurface (as `OnAcceleratedPaint` hands it over), the Metal conversion and turn
/// in `SurfaceFrameSource`, a `.virtual` port's software clock taking frames by
/// itself, and the shim scheduler's counts. What the app wires up per card output
/// (`CardOutput`), minus Chromium, which is driven end to end instead.
@Suite(.enabled(if: GPU.available, GPU.skipped)) struct CardPathTests {
  /// The first eight bytes of a UYVY line of white, or of black, read as the
  /// software clock records what went out (little-endian).
  static let white = Int64(littleEndian: Data([128, 235, 128, 235, 128, 235, 128, 235]).withUnsafeBytes { $0.load(as: Int64.self) })
  static let black = Int64(littleEndian: Data([128, 16, 128, 16, 128, 16, 128, 16]).withUnsafeBytes { $0.load(as: Int64.self) })

  /// A portrait page for a 720p port turned a quarter: 720 x 1280, black but for
  /// its bottom four lines, which are white. Turned 90 degrees clockwise the
  /// bottom of the page is the left edge of the frame, so every line of the frame
  /// starts with four white pixels. Unturned (scaled to fit) or turned the other
  /// way, every line starts black.
  static func portraitPage() -> IOSurfaceRef {
    let (w, h) = (720, 1280)
    var pixels = [RGB](repeating: .grey(0), count: w * h)
    for y in (h - 4)..<h { for x in 0..<w { pixels[y * w + x] = .grey(255) } }
    return bgraSurface(width: w, height: h, pixels)
  }

  /// A 720p59.94 port on a software clock the test moves by hand, so the counts are
  /// the same on any machine: a clock ticking by itself on a busy runner wakes late
  /// and misses slots, which is the scheduler's own accounting (tested in
  /// OutputPortTests), not this path's. Real time is driven on a card instead.
  func run(rotation: Rotation) throws -> (counts: CardCounters, shown: [Int64], taken: Int, health: HealthSample) {
    let source = SurfaceFrameSource(converter: try UYVYConverter())
    let taken = Locked(0)
    source.onBeginFrame = { _ in taken.value += 1 }
    source.rotation = rotation
    let port = DeckLinkOutputPort(
      label: "SDI 1 (virtual)",
      hardware: .softwareClock(width: 1280, height: 720, frameDuration: 1001, timeScale: 60000, ticksByItself: false),
      source: source, retryInterval: 3600, pollInterval: 3600, log: LogLines().write)
    #expect(port.open(videoMode: nil) == .running(mode: "1280x720 at 59.94 on a software clock", frames: .card))
    // The pre-roll's fills tell the source the frame size; then the picture.
    port.fakeTick(1)
    try source.present(Self.portraitPage())
    source.waitForConversions()
    port.fakeTick(Self.ticks)
    // What went out is the software clock's record, gone once the output closes.
    let shown = port.fakeShown()
    let health = port.takeHealthSample()
    port.close()
    return (port.counters, shown, taken.value, health)
  }

  static let ticks = 12

  @Test func aTurnedPictureFlowsFromTheSourceThroughThePortIntoTheCounts() throws {
    let r = try run(rotation: .clockwise90)
    // One picture presented: exactly one new frame, every other frame a repeat of it
    // (or of the black the frames start as, before it), none missed.
    #expect(r.counts.rendered == 1)
    #expect(r.counts.scheduled > UInt64(Self.ticks))
    #expect(r.counts.repeated == r.counts.scheduled - 1)
    #expect(r.counts.missed == 0)
    // The page is asked to draw for the slots the clock moved through.
    #expect(r.taken > 0 && UInt64(r.taken) <= r.counts.scheduled)
    // What went out: the turned picture, whole (no line torn from another), held.
    let first = try #require(r.shown.firstIndex(of: Self.white), "the turned picture never went out: \(Set(r.shown))")
    #expect(r.shown[first...].allSatisfy { $0 == Self.white })
    #expect(r.shown[..<first].allSatisfy { $0 == Self.black || $0 == -1 })
    #expect(r.health.dropped == 0)
    #expect(r.health.repeated > 0 && r.health.repeated < 100)
  }

  /// The same page with no turn, or the other turn, starts every line black: the
  /// test above passes because of the turn, not in spite of it.
  @Test func theOtherTurnsDoNotPutTheBottomOnTheLeft() throws {
    for rotation in [Rotation.none, .clockwise270] {
      let r = try run(rotation: rotation)
      #expect(r.counts.rendered == 1)
      #expect(!r.shown.contains(Self.white), "\(rotation)")
    }
  }

  /// Waits for something a self-ticking clock makes happen, up to a deadline long
  /// enough for a busy CI runner, instead of sleeping a fixed time and hoping.
  func eventually(within seconds: Double = 5, _ done: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(seconds)
    while !done() && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
  }

  /// `--dump-frames` writes the frame as the card was sent it: decoded, the
  /// turned picture comes back, white down the left edge.
  @Test func theDumpIsTheTurnedFrame() async throws {
    let source = SurfaceFrameSource(converter: try UYVYConverter())
    source.rotation = .clockwise90
    let got = Locked<CardFrameCopy?>(nil)
    source.captureNextFrame { got.value = $0 }
    let port = virtualPort(source, opened: Locked([]))
    port.open(videoMode: "720p59.94")
    try source.present(Self.portraitPage())
    try await eventually { got.value != nil }
    port.close()
    let frame = try #require(got.value)
    #expect(frame.width == 1280 && frame.height == 720)
    let rgba = UYVYDecode.rgba(frame.bytes, width: frame.width, height: frame.height, rowBytes: frame.rowBytes)
    func pixel(_ x: Int, _ y: Int) -> [UInt8] { Array(rgba[(y * frame.width + x) * 4..<(y * frame.width + x) * 4 + 3]) }
    #expect(pixel(0, 0) == [255, 255, 255] && pixel(3, 719) == [255, 255, 255])
    #expect(pixel(4, 0) == [0, 0, 0] && pixel(1279, 360) == [0, 0, 0])
  }

  /// A white picture, scaled to fit whatever the frame size is.
  static func whitePage() -> IOSurfaceRef { bgraSurface(width: 4, height: 4, Array(repeating: .grey(255), count: 16)) }

  func virtualPort(_ source: SurfaceFrameSource, opened: Locked<[PixelSize]>) -> DeckLinkOutputPort {
    let port = DeckLinkOutputPort(
      label: "SDI 1 (virtual)", hardware: .virtual, source: source, retryInterval: 3600, pollInterval: 3600,
      log: LogLines().write)
    port.onOpened = { size in opened.value.append(size) }
    return port
  }

  /// A port another application holds when the output starts opens only on a
  /// retry. The page's pictures go out from then: the source learns the frame size
  /// from the port's first fill, whenever that comes, and the port says it opened,
  /// and at what size, so the page is laid out then too. Laid out only when the
  /// format was asked for, the source had no size and dropped every picture, and
  /// the card sent black for good.
  @Test func aPortThatOpensOnlyOnARetrySendsThePagesPictures() async throws {
    let source = SurfaceFrameSource(converter: try UYVYConverter())
    let opened = Locked<[PixelSize]>([])
    let port = virtualPort(source, opened: opened)
    port.fakeRefuseOpens("the port is in use by another application")
    #expect(port.open(videoMode: "720p59.94") == .lost("the port is in use by another application"))
    try source.present(Self.whitePage())  // nothing to convert to yet: dropped
    port.fakeRefuseOpens(nil)
    port.retry()
    port.sync()
    #expect(port.state == .running(mode: "720p59.94 on a software clock", frames: .card))
    #expect(opened.value == [PixelSize(width: 1280, height: 720)])
    try source.present(Self.whitePage())
    try await eventually { port.fakeShown().contains(Self.white) }
    let shown = port.fakeShown()
    port.close()
    #expect(shown.contains(Self.white), "the page's picture never went out: \(Set(shown))")
  }

  /// A screen's format changed while its port was unplugged: the port cannot open in
  /// it then, and opens in it on the retry. Its pictures go out at the new size,
  /// not refused for being converted at the old one.
  @Test func aFormatChangedWhileThePortIsLostIsTheSizeItsPicturesGoOutAt() async throws {
    let source = SurfaceFrameSource(converter: try UYVYConverter())
    let opened = Locked<[PixelSize]>([])
    let port = virtualPort(source, opened: opened)
    defer { port.close() }
    #expect(port.open(videoMode: "720p59.94") == .running(mode: "720p59.94 on a software clock", frames: .card))
    try source.present(Self.whitePage())
    try await eventually { port.fakeShown().contains(Self.white) }
    #expect(port.fakeShown().contains(Self.white))

    port.fakeRefuseOpens("the port is not connected")
    port.fakeUnplug()
    port.sync()
    #expect(port.open(videoMode: "1080p59.94") == .lost("the port is not connected"))
    port.fakeRefuseOpens(nil)
    port.retry()
    port.sync()
    #expect(port.state == .running(mode: "1080p59.94 on a software clock", frames: .card))
    #expect(opened.value == [PixelSize(width: 1280, height: 720), PixelSize(width: 1920, height: 1080)])
    try source.present(Self.whitePage())
    try await eventually { port.fakeShown().contains(Self.white) }
    let shown = port.fakeShown()
    #expect(shown.contains(Self.white), "no picture went out at the new size: \(Set(shown))")
  }

  /// A capture asked for again before a new frame came gets nothing, not a pile-up.
  @Test func aCaptureReplacedBeforeAFrameGetsNil() throws {
    let source = SurfaceFrameSource(converter: try UYVYConverter())
    var results: [Bool] = []
    source.captureNextFrame { results.append($0 != nil) }
    source.captureNextFrame { results.append($0 != nil) }
    #expect(results == [false])
  }
}
