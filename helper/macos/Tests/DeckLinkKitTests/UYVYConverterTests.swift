import Foundation
import IOSurface
import Metal
import StageUtilityOutputCore
import Testing
@testable import DeckLinkKit

/// An 8-bit RGB colour, as the page draws it.
struct RGB: Equatable {
  var r: UInt8
  var g: UInt8
  var b: UInt8
  static func grey(_ v: UInt8) -> RGB { RGB(r: v, g: v, b: v) }
}

/// A 32-bit BGRA IOSurface holding `pixels`, row by row.
func bgraSurface(width: Int, height: Int, _ pixels: [RGB]) -> IOSurfaceRef {
  precondition(pixels.count == width * height)
  let properties: [String: Any] = [
    kIOSurfaceWidth as String: width, kIOSurfaceHeight as String: height, kIOSurfaceBytesPerElement as String: 4,
    kIOSurfacePixelFormat as String: 0x4247_5241,  // 'BGRA'
  ]
  let surface = IOSurfaceCreate(properties as CFDictionary)!
  IOSurfaceLock(surface, [], nil)
  let base = IOSurfaceGetBaseAddress(surface)
  let rowBytes = IOSurfaceGetBytesPerRow(surface)
  for y in 0..<height {
    for x in 0..<width {
      let p = pixels[y * width + x]
      let at = base + y * rowBytes + x * 4
      at.storeBytes(of: p.b, toByteOffset: 0, as: UInt8.self)
      at.storeBytes(of: p.g, toByteOffset: 1, as: UInt8.self)
      at.storeBytes(of: p.r, toByteOffset: 2, as: UInt8.self)
      at.storeBytes(of: 255, toByteOffset: 3, as: UInt8.self)
    }
  }
  IOSurfaceUnlock(surface, [], nil)
  return surface
}

/// A frame's memory, as the shim hands it to a fill.
final class FrameMemory {
  let target: CardFrameTarget
  init(width: Int, height: Int) {
    let page = Int(getpagesize())
    let length = (width * 2 * height + page - 1) / page * page
    var raw: UnsafeMutableRawPointer?
    posix_memalign(&raw, page, length)
    memset(raw!, 0, length)
    target = CardFrameTarget(bytes: raw!, length: length, rowBytes: width * 2, width: width, height: height, slot: 0)
  }
  deinit { free(target.bytes) }

  /// Each pixel pair as (Cb, Y0, Cr, Y1).
  var pairs: [[UInt8]] {
    let bytes = target.bytes.assumingMemoryBound(to: UInt8.self)
    return stride(from: 0, to: target.rowBytes * target.height, by: 4).map { Array(UnsafeBufferPointer(start: bytes + $0, count: 4)) }
  }

  /// The luma of every pixel, row by row.
  var lumas: [UInt8] { pairs.flatMap { [$0[1], $0[3]] } }
}

extension SurfaceFrameSource {
  /// Have a port of `width` x `height` ask for a frame, as its pre-roll does: the
  /// source learns the size its pictures are converted to.
  func learnSize(width: Int, height: Int) {
    let frame = FrameMemory(width: width, height: height)
    _ = fill(CardFrameRequest(index: 0, streamTime: 0, timeScale: 60000), into: frame.target)
  }
}

@Suite(.enabled(if: GPU.available, GPU.skipped)) struct UYVYConverterTests {
  let converter: UYVYConverter
  init() throws { converter = try UYVYConverter() }

  /// The path a picture takes: into a buffer of the converter's own
  /// (`makeFrameBuffer`), as `SurfaceFrameSource` converts it, then read back into
  /// `frame` to be checked.
  func convert(_ width: Int, _ height: Int, _ pixels: [RGB], rotation: Rotation = .none, into frame: FrameMemory)
    throws
  {
    let texture = try #require(converter.texture(for: bgraSurface(width: width, height: height, pixels)))
    let t = frame.target
    let buffer = try converter.makeFrameBuffer(rowBytes: t.rowBytes, height: t.height)
    try converter.convert(texture, rotation: rotation, into: buffer, width: t.width, height: t.height, rowBytes: t.rowBytes)
    t.bytes.copyMemory(from: buffer.contents(), byteCount: t.rowBytes * t.height)
  }

  @Test func whiteAndBlackAreTheEndsOfVideoRange() throws {
    let frame = FrameMemory(width: 4, height: 2)
    try convert(4, 2, Array(repeating: RGB.grey(255), count: 8), into: frame)
    #expect(frame.pairs == Array(repeating: [128, 235, 128, 235], count: 4))
    try convert(4, 2, Array(repeating: RGB.grey(0), count: 8), into: frame)
    #expect(frame.pairs == Array(repeating: [128, 16, 128, 16], count: 4))
  }

  /// SMPTE 75% colour bars, against the 8-bit Rec. 709 values published for them
  /// (SMPTE RP 219), each bar two pixels wide so each pair is one colour. A Rec.
  /// 601 matrix gives yellow Y 161, not 168.
  @Test func theSeventyFivePercentBarsAreRec709() throws {
    let v: UInt8 = 191
    let bars: [(RGB, [UInt8])] = [
      (RGB(r: v, g: v, b: v), [128, 180, 128, 180]),  // white
      (RGB(r: v, g: v, b: 0), [44, 168, 136, 168]),  // yellow
      (RGB(r: 0, g: v, b: v), [147, 145, 44, 145]),  // cyan
      (RGB(r: 0, g: v, b: 0), [63, 133, 52, 133]),  // green
      (RGB(r: v, g: 0, b: v), [193, 63, 204, 63]),  // magenta
      (RGB(r: v, g: 0, b: 0), [109, 51, 212, 51]),  // red
      (RGB(r: 0, g: 0, b: v), [212, 28, 120, 28]),  // blue
    ]
    let row = bars.flatMap { [$0.0, $0.0] }
    let frame = FrameMemory(width: 14, height: 2)
    try convert(14, 2, row + row, into: frame)
    let expected = bars.map(\.1)
    #expect(frame.pairs == expected + expected)
  }

  /// Eight distinct greys, a to h, so each output pixel's luma says which input
  /// pixel it shows. The expected frames are the pictures turned by hand.
  @Test func theFrameIsTheUprightPictureTurnedClockwise() throws {
    let greys: [UInt8] = [20, 50, 80, 110, 140, 170, 200, 230]
    let (a, b, c, d, e, f, g, h) = (greys[0], greys[1], greys[2], greys[3], greys[4], greys[5], greys[6], greys[7])
    func luma(_ v: UInt8) -> UInt8 { UInt8((16 + 219 * Double(v) / 255).rounded()) }
    let frame = FrameMemory(width: 4, height: 2)

    // Upright 4 x 2:  a b c d / e f g h
    let landscape = greys.map(RGB.grey)
    try convert(4, 2, landscape, rotation: .none, into: frame)
    #expect(frame.lumas == [a, b, c, d, e, f, g, h].map(luma))
    try convert(4, 2, landscape, rotation: .clockwise180, into: frame)
    #expect(frame.lumas == [h, g, f, e, d, c, b, a].map(luma))

    // A quarter turn: the page is laid out portrait, 2 x 4:  a b / c d / e f / g h
    let portrait = greys.map(RGB.grey)
    try convert(2, 4, portrait, rotation: .clockwise90, into: frame)
    #expect(frame.lumas == [g, e, c, a, h, f, d, b].map(luma))
    try convert(2, 4, portrait, rotation: .clockwise270, into: frame)
    #expect(frame.lumas == [b, d, f, h, a, c, e, g].map(luma))
    #expect(frame.pairs.allSatisfy { $0[0] == 128 && $0[2] == 128 })
  }

  /// A colour picture turned a half turn: red on the left becomes red on the right.
  @Test func aTurnMovesColourToo() throws {
    let red = RGB(r: 191, g: 0, b: 0)
    let blue = RGB(r: 0, g: 0, b: 191)
    let frame = FrameMemory(width: 4, height: 1)
    try convert(4, 1, [red, red, blue, blue], rotation: .clockwise180, into: frame)
    #expect(frame.pairs == [[212, 28, 120, 28], [109, 51, 212, 51]])
  }

  /// A pair of two colours shares the average of their chroma: red beside blue is
  /// neither red's Cb/Cr (109, 212) nor blue's (212, 120).
  @Test func aPairSharesTheAverageOfItsChroma() throws {
    let frame = FrameMemory(width: 2, height: 1)
    try convert(2, 1, [RGB(r: 191, g: 0, b: 0), RGB(r: 0, g: 0, b: 191)], into: frame)
    #expect(frame.pairs == [[160, 51, 166, 28]])
  }

  @Test func aPictureOfAnotherSizeIsScaledToFit() throws {
    // 8 x 2 onto 4 x 2: every other pixel.
    let greys: [UInt8] = [10, 0, 60, 0, 110, 0, 160, 0, 30, 0, 80, 0, 130, 0, 180, 0]
    let frame = FrameMemory(width: 4, height: 2)
    try convert(8, 2, greys.map(RGB.grey), into: frame)
    #expect(frame.lumas == [10, 60, 110, 160, 30, 80, 130, 180].map { UInt8((16 + 219 * Double($0) / 255).rounded()) })
  }

  @Test func anOddWidthIsRefused() throws {
    let buffer = try converter.makeFrameBuffer(rowBytes: 8, height: 1)
    let texture = try #require(converter.texture(for: bgraSurface(width: 3, height: 1, Array(repeating: .grey(0), count: 3))))
    #expect(throws: UYVYConverter.Failure.notPixelPairs(width: 3)) {
      try converter.convert(texture, rotation: .none, into: buffer, width: 3, height: 1, rowBytes: 8)
    }
  }

  @Test func aSurfaceSourceSendsEachPictureOnceAndThenRepeats() throws {
    let source = SurfaceFrameSource(converter: converter)
    source.learnSize(width: 4, height: 1)
    let frame = FrameMemory(width: 4, height: 1)
    let request = CardFrameRequest(index: 0, streamTime: 0, timeScale: 60000)
    var begun: [Int64] = []
    source.onBeginFrame = { begun.append($0.index) }

    #expect(source.fill(request, into: frame.target) == nil)  // nothing presented yet
    source.begin(CardFrameRequest(index: 7, streamTime: 0, timeScale: 60000))
    try source.present(bgraSurface(width: 4, height: 1, Array(repeating: .grey(255), count: 4)))
    source.waitForConversions()
    #expect(source.fill(request, into: frame.target) != nil)
    #expect(frame.pairs == [[128, 235, 128, 235], [128, 235, 128, 235]])
    #expect(source.fill(request, into: frame.target) == nil)  // the same picture: a repeat

    source.rotation = .clockwise180
    try source.present(bgraSurface(width: 4, height: 1, [.grey(0), .grey(0), .grey(255), .grey(255)]))
    source.waitForConversions()
    #expect(source.fill(request, into: frame.target) != nil)
    #expect(frame.pairs == [[128, 235, 128, 235], [128, 16, 128, 16]])
    #expect(begun == [7])
    #expect(source.failure == nil)
  }

  /// A picture is converted when it is presented, at the card's frame size: until a
  /// port has asked for a frame there is no size to convert to, and the picture is
  /// dropped rather than sent at the wrong size. The first fill, empty, is where the
  /// source learns it.
  @Test func aPictureBeforeTheFrameSizeIsKnownIsDropped() throws {
    let source = SurfaceFrameSource(converter: converter)
    let frame = FrameMemory(width: 2, height: 1)
    let request = CardFrameRequest(index: 0, streamTime: 0, timeScale: 60000)
    try source.present(bgraSurface(width: 2, height: 1, [.grey(255), .grey(255)]))
    source.waitForConversions()
    #expect(source.frameSize == nil)
    #expect(source.fill(request, into: frame.target) == nil)
    #expect(source.frameSize.map { [$0.width, $0.height] } == [2, 1])
    try source.present(bgraSurface(width: 2, height: 1, [.grey(255), .grey(255)]))
    source.waitForConversions()
    #expect(source.fill(request, into: frame.target) != nil)
  }

  /// A picture converted for one frame size is not copied into a frame of another:
  /// a port reopened in a bigger mode fills its pre-roll before the source learns
  /// the new size, and copying the old picture would read past its buffer.
  @Test func aPictureOfTheOldSizeIsNotCopiedIntoANewFrame() throws {
    let source = SurfaceFrameSource(converter: converter)
    source.learnSize(width: 2, height: 1)
    try source.present(bgraSurface(width: 2, height: 1, [.grey(255), .grey(255)]))
    source.waitForConversions()
    let bigger = FrameMemory(width: 4, height: 2)
    #expect(source.fill(CardFrameRequest(index: 0, streamTime: 0, timeScale: 60000), into: bigger.target) == nil)
  }

  /// A picture's times: drawn for the begin frame it answers, handed over when
  /// presented, ready once converted; or drawn when the caller says, as the latency
  /// page's stamp does.
  @Test func aPictureCarriesTheTimesItWasMadeAt() throws {
    let clock = Locked<UInt64>(1_000)
    let source = SurfaceFrameSource(converter: converter, now: { clock.value })
    source.learnSize(width: 2, height: 1)
    let frame = FrameMemory(width: 2, height: 1)
    let request = CardFrameRequest(index: 0, streamTime: 0, timeScale: 60000)
    let white = bgraSurface(width: 2, height: 1, [.grey(255), .grey(255)])

    source.begin(request)  // at 1000
    clock.value = 2_000
    try source.present(white)
    source.waitForConversions()
    let picture = try #require(source.fill(request, into: frame.target))
    #expect(picture.contentNs == 1_000)
    #expect(picture.paintNs == 2_000)
    #expect(picture.readyNs == 2_000)

    clock.value = 3_000
    try source.present(white, contentNs: 2_750)
    source.waitForConversions()
    #expect(source.fill(request, into: frame.target)?.contentNs == 2_750)
    // Handed over with no begin frame to answer: when it was drawn is unknown.
    try source.present(white)
    source.waitForConversions()
    #expect(source.fill(request, into: frame.target)?.contentNs == 0)
  }

  /// A picture slower than a frame arrives after the next begin frame was asked
  /// for. CEF sent no begin frame for that one (one was still being drawn), so the
  /// picture answers the first: it is timed from it, 20 ms, not from the second, which
  /// would read 3.3 ms. The begin after the picture is answered by the next.
  @Test func aSlowPictureIsTimedFromTheBeginItAnswers() throws {
    let clock = Locked<UInt64>(1_000_000)
    let source = SurfaceFrameSource(converter: converter, now: { clock.value })
    source.learnSize(width: 2, height: 1)
    let frame = FrameMemory(width: 2, height: 1)
    let request = CardFrameRequest(index: 0, streamTime: 0, timeScale: 60000)
    let white = bgraSurface(width: 2, height: 1, [.grey(255), .grey(255)])

    source.begin(request)  // 1 ms
    clock.value = 17_683_333
    source.begin(request)  // a frame later, while the first is still being drawn
    clock.value = 21_000_000
    try source.present(white)
    source.waitForConversions()
    #expect(source.fill(request, into: frame.target)?.contentNs == 1_000_000)

    clock.value = 34_366_667
    source.begin(request)
    clock.value = 35_000_000
    try source.present(white)
    source.waitForConversions()
    #expect(source.fill(request, into: frame.target)?.contentNs == 34_366_667)
  }

  /// A begin frame the clock thread asks for just after the main thread took the
  /// picture's time is not what that picture answers: the picture is unknown, and
  /// the begin is left for the next.
  @Test func aBeginAfterThePictureIsNotWhatItAnswers() throws {
    let clock = Locked<UInt64>(5_000_000)
    let source = SurfaceFrameSource(converter: converter, now: { clock.value })
    source.learnSize(width: 2, height: 1)
    let frame = FrameMemory(width: 2, height: 1)
    let request = CardFrameRequest(index: 0, streamTime: 0, timeScale: 60000)
    let white = bgraSurface(width: 2, height: 1, [.grey(255), .grey(255)])
    source.begin(request)  // stamped at 5 ms
    clock.value = 4_000_000  // the picture's time, taken before it
    try source.present(white)
    source.waitForConversions()
    #expect(source.fill(request, into: frame.target)?.contentNs == 0)
    clock.value = 6_000_000
    try source.present(white)
    source.waitForConversions()
    #expect(source.fill(request, into: frame.target)?.contentNs == 5_000_000)
  }

  /// A begin frame no picture ever answered (a browser that drew nothing for it) is
  /// given up after `answerWithinNs`, so it does not time the pictures after it.
  @Test func aBeginNeverAnsweredIsGivenUp() throws {
    let clock = Locked<UInt64>(1_000_000)
    let source = SurfaceFrameSource(converter: converter, now: { clock.value })
    source.learnSize(width: 2, height: 1)
    let frame = FrameMemory(width: 2, height: 1)
    let request = CardFrameRequest(index: 0, streamTime: 0, timeScale: 60000)
    source.begin(request)
    clock.value += SurfaceFrameSource.answerWithinNs + 1
    let later = clock.value
    source.begin(request)
    clock.value += 2_000_000
    try source.present(bgraSurface(width: 2, height: 1, [.grey(255), .grey(255)]))
    source.waitForConversions()
    #expect(source.fill(request, into: frame.target)?.contentNs == later)
  }

  /// The engine's surface is valid only inside its paint callback; CEF reuses it once
  /// the callback returns. `present` returns once the picture has been copied out,
  /// so a surface drawn over straight after does not reach the card: here the
  /// surface is turned black the moment `present` returns, and the frame is white.
  /// Not timed: that `present` then returns before the conversion is done, holding
  /// the main thread for the copy alone, is a matter of how busy the GPU is, and was
  /// measured on the card (DECKLINK.md, "How many outputs").
  @Test func theSurfaceMayBeReusedOnceThePictureIsHandedOver() throws {
    let source = SurfaceFrameSource(converter: converter)
    source.learnSize(width: 1920, height: 1080)
    let surface = bgraSurface(width: 1920, height: 1080, Array(repeating: .grey(255), count: 1920 * 1080))
    try source.present(surface)
    IOSurfaceLock(surface, [], nil)
    memset(IOSurfaceGetBaseAddress(surface), 0, IOSurfaceGetBytesPerRow(surface) * 1080)
    IOSurfaceUnlock(surface, [], nil)
    source.waitForConversions()
    let frame = FrameMemory(width: 1920, height: 1080)
    let picture = try #require(source.fill(CardFrameRequest(index: 0, streamTime: 0, timeScale: 60000), into: frame.target))
    let bytes = frame.target.bytes.assumingMemoryBound(to: UInt8.self)
    #expect(Array(UnsafeBufferPointer(start: bytes, count: 4)) == [128, 235, 128, 235])
    #expect(Array(UnsafeBufferPointer(start: bytes + 1079 * 3840 + 3836, count: 4)) == [128, 235, 128, 235])
    #expect(picture.paintNs <= picture.returnedNs && picture.returnedNs <= picture.readyNs)
  }

  /// Two pictures before the card takes a frame: the newer goes out, once, and the
  /// older is never sent. Every frame went out, so neither is a repeat or a drop.
  @Test func twoPicturesBeforeAFrameSendTheNewerOnce() throws {
    let source = SurfaceFrameSource(converter: converter)
    let frame = FrameMemory(width: 2, height: 1)
    let request = CardFrameRequest(index: 0, streamTime: 0, timeScale: 60000)
    source.learnSize(width: 2, height: 1)
    try source.present(bgraSurface(width: 2, height: 1, [.grey(255), .grey(255)]))
    source.waitForConversions()
    try source.present(bgraSurface(width: 2, height: 1, [.grey(0), .grey(0)]))
    source.waitForConversions()
    #expect(source.fill(request, into: frame.target) != nil)
    #expect(frame.pairs == [[128, 16, 128, 16]])
    #expect(source.fill(request, into: frame.target) == nil)
  }
}
