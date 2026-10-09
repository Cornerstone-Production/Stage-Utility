import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct UYVYDecodeTests {
  func rgb(_ pairs: [[UInt8]], width: Int) -> [[UInt8]] {
    let rgba = UYVYDecode.rgba(pairs.flatMap { $0 }, width: width, height: 1, rowBytes: width * 2)
    return stride(from: 0, to: rgba.count, by: 4).map { Array(rgba[$0..<($0 + 3)]) }
  }

  @Test func theEndsOfVideoRangeAreWhiteAndBlack() {
    #expect(rgb([[128, 235, 128, 235], [128, 16, 128, 16]], width: 4) == [[255, 255, 255], [255, 255, 255], [0, 0, 0], [0, 0, 0]])
  }

  /// The 75% bars, from the 8-bit Rec. 709 values published for them (SMPTE RP 219,
  /// the same table the converter is tested against), back to within 1 of 191 and 0.
  @Test func theSeventyFivePercentBarsComeBack() {
    let bars: [([UInt8], [Int])] = [
      ([44, 168, 136, 168], [191, 191, 0]),
      ([147, 145, 44, 145], [0, 191, 191]),
      ([63, 133, 52, 133], [0, 191, 0]),
      ([193, 63, 204, 63], [191, 0, 191]),
      ([109, 51, 212, 51], [191, 0, 0]),
      ([212, 28, 120, 28], [0, 0, 191]),
    ]
    for (pair, want) in bars {
      let got = rgb([pair], width: 2)
      #expect(got.count == 2)
      for px in got { #expect(zip(px, want).allSatisfy { abs(Int($0) - $1) <= 1 }, "\(pair) gave \(px)") }
    }
  }

  /// Padded lines: only `width` pixels of each are read.
  @Test func aLinePaddedPastThePictureIsReadByItsRowLength() {
    let bytes: [UInt8] = [128, 235, 128, 235, 0, 0, 0, 0, 128, 16, 128, 16, 0, 0, 0, 0]
    let rgba = UYVYDecode.rgba(bytes, width: 2, height: 2, rowBytes: 8)
    #expect(rgba == [255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255])
  }

  @Test func tooFewBytesIsNothing() {
    #expect(UYVYDecode.rgba([128, 235], width: 2, height: 1, rowBytes: 4).isEmpty)
    #expect(UYVYDecode.rgba([128, 235, 128, 235], width: 3, height: 1, rowBytes: 6).isEmpty)
  }
}
