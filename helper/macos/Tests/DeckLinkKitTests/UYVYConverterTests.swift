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

/// Page-aligned frame memory, as the shim hands it over.
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

@Suite struct UYVYConverterTests {
  let converter: UYVYConverter
  init() throws { converter = try UYVYConverter() }

  func convert(_ width: Int, _ height: Int, _ pixels: [RGB], rotation: Rotation = .none, into frame: FrameMemory)
    throws
  {
    let texture = try #require(converter.texture(for: bgraSurface(width: width, height: height, pixels)))
    try converter.convert(texture, rotation: rotation, into: frame.target)
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

  @Test func aPictureOfAnotherSizeIsScaledToFit() throws {
    // 8 x 2 onto 4 x 2: every other pixel.
    let greys: [UInt8] = [10, 0, 60, 0, 110, 0, 160, 0, 30, 0, 80, 0, 130, 0, 180, 0]
    let frame = FrameMemory(width: 4, height: 2)
    try convert(8, 2, greys.map(RGB.grey), into: frame)
    #expect(frame.lumas == [10, 60, 110, 160, 30, 80, 130, 180].map { UInt8((16 + 219 * Double($0) / 255).rounded()) })
  }

  @Test func anOddWidthIsRefused() throws {
    let frame = FrameMemory(width: 4, height: 1)
    var target = frame.target
    target.width = 3
    let texture = try #require(converter.texture(for: bgraSurface(width: 3, height: 1, Array(repeating: .grey(0), count: 3))))
    #expect(throws: UYVYConverter.Failure.notPixelPairs(width: 3)) {
      try converter.convert(texture, rotation: .none, into: target)
    }
  }

  @Test func aSurfaceSourceSendsEachPictureOnceAndThenRepeats() throws {
    let source = SurfaceFrameSource(converter: converter)
    let frame = FrameMemory(width: 4, height: 1)
    let request = CardFrameRequest(index: 0, streamTime: 0, timeScale: 60000)
    var taken: [Int64] = []
    source.onFrameTaken = { taken.append($0.index) }

    #expect(source.fill(request, into: frame.target) == false)  // nothing presented yet
    try source.present(bgraSurface(width: 4, height: 1, Array(repeating: .grey(255), count: 4)))
    #expect(source.fill(request, into: frame.target) == true)
    #expect(frame.pairs == [[128, 235, 128, 235], [128, 235, 128, 235]])
    #expect(source.fill(request, into: frame.target) == false)  // the same picture: a repeat

    source.rotation = .clockwise180
    try source.present(bgraSurface(width: 4, height: 1, [.grey(0), .grey(0), .grey(255), .grey(255)]))
    #expect(source.fill(request, into: frame.target) == true)
    #expect(frame.pairs == [[128, 235, 128, 235], [128, 16, 128, 16]])
    #expect(taken == [0, 0, 0, 0])
    #expect(source.failure == nil)
  }
}
