import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct FrameTimingTests {
  /// Nearest rank: the p50 of 1...10 is 5, the p95 10; nothing is interpolated, so
  /// every figure reported is a time that was measured.
  @Test func percentilesAreNearestRank() throws {
    let d = try #require(Distribution.of((1...10).map(Double.init).shuffled()))
    #expect(d == Distribution(count: 10, p50: 5, p95: 10, max: 10))
    #expect(Distribution.of([]) == nil)
    #expect(Distribution.of([7])?.p95 == 7)
  }

  @Test func renderToAirNeedsBothEnds() {
    #expect(FrameTiming(index: 1, contentNs: 1_000_000, airNs: 21_000_000).renderToAirMs == 20)
    #expect(FrameTiming(index: 1, contentNs: 0, airNs: 21_000_000).renderToAirMs == nil)
    #expect(FrameTiming(index: 1, contentNs: 1_000_000, airNs: 0).renderToAirMs == nil)
  }

  /// The budget is over the new pictures that went out: a repeat carries an older
  /// picture's times and a skip sent nothing, so neither says what a picture costs.
  @Test func theBreakdownCountsOnlyNewPicturesThatWentOut() throws {
    let ms: UInt64 = 1_000_000
    let sent = FrameTiming(
      index: 2, contentNs: 10 * ms, paintNs: 12 * ms, readyNs: 13 * ms, fillNs: 25 * ms, copiedNs: 26 * ms,
      scheduledNs: 27 * ms, airNs: 30 * ms, completedNs: 46 * ms)
    var repeated = sent
    repeated.fresh = false
    repeated.airNs = 99 * ms
    let skipped = FrameTiming(index: 3, fresh: false, skipped: true, airNs: 50 * ms)
    let b = LatencyBreakdown.of([sent, repeated, skipped])
    #expect(b.renderToAir == Distribution(count: 1, p50: 20, p95: 20, max: 20))
    #expect(b.contentToPaint?.p50 == 2)
    #expect(b.paintToReady?.p50 == 1)
    #expect(b.readyToFill?.p50 == 12)
    #expect(b.fillToCopied?.p50 == 1)
    #expect(b.copiedToScheduled?.p50 == 1)
    #expect(b.scheduledToAir?.p50 == 3)
    #expect(b.airToCompleted?.p50 == 16)
  }

  /// Said when first measured, and again only for a change of a few milliseconds
  /// either way, not for every window's fraction of one.
  @Test func latencyIsLoggedWhenFirstKnownAndWhenItMoves() {
    #expect(LatencyLog.worthSaying(20.0, after: nil))
    #expect(!LatencyLog.worthSaying(21.9, after: 20.0))
    #expect(!LatencyLog.worthSaying(16.1, after: 20.0))
    #expect(LatencyLog.worthSaying(24.0, after: 20.0))
    #expect(LatencyLog.worthSaying(16.0, after: 20.0))
  }

  @Test func theCSVLineFollowsTheHeader() {
    let t = FrameTiming(
      index: 7, fresh: false, skipped: false, result: 1, contentNs: 1, paintNs: 2, readyNs: 3, fillNs: 4,
      copiedNs: 5, scheduledNs: 6, airNs: 8, completedNs: 9, returnedNs: 10)
    let line = FrameTimingCSV.line(output: "SDI 1", t)
    #expect(line == "SDI 1,7,0,0,1,1,2,3,4,5,6,8,9,10")
    #expect(line.split(separator: ",").count == FrameTimingCSV.header.split(separator: ",").count)
  }
}

@Suite struct LatencyPageTests {
  typealias Stamp = LatencyPage.Stamp

  @Test func aStampReadsBackAsItWasWritten() {
    for micros: UInt64 in [0, 1, 1_791_576_109_260_337, Stamp.modulus - 1] {
      let bits = Stamp.encode(micros)
      #expect(bits.count == Stamp.blocks)
      #expect(Stamp.decode { bits[$0] } == micros % Stamp.modulus)
    }
  }

  /// A page that is not the latency page, or a stamp with a block misread, is not a
  /// time: the marker and the checksum both have to hold.
  @Test func aWrongMarkerOrChecksumIsNoStamp() {
    var bits = Stamp.encode(1_791_576_109_260_337)
    #expect(Stamp.decode { _ in false } == nil)
    bits[20].toggle()  // a time bit: the checksum no longer adds up
    #expect(Stamp.decode { bits[$0] } == nil)
    var marker = Stamp.encode(42)
    marker[0].toggle()
    #expect(Stamp.decode { marker[$0] } == nil)
    #expect(Stamp.decode { $0 == 30 ? nil : bits[$0] } == nil)
  }

  /// The stamp keeps 40 bits; the whole time comes back from a time near it, even
  /// across the point where those 40 bits wrap.
  @Test func aStampUnwrapsToTheTimeNearestNow() {
    let now: UInt64 = 1_791_576_109_260_337
    #expect(Stamp.unwrap((now - 16_000) % Stamp.modulus, near: now) == now - 16_000)
    let edge = (now / Stamp.modulus + 1) * Stamp.modulus  // just after a wrap
    #expect(Stamp.unwrap((edge - 5) % Stamp.modulus, near: edge + 3) == edge - 5)
  }

  /// Drawn 16 ms before the epoch time read with the host time: 16 ms before that
  /// host time.
  @Test func aStampIsPlacedOnTheHostClock() {
    let epoch: UInt64 = 1_791_576_109_260_337
    let host: UInt64 = 5_000_000_000
    #expect(Stamp.hostNs(of: (epoch - 16_000) % Stamp.modulus, epochNowMicros: epoch, hostNowNs: host) == host - 16_000_000)
  }

  // Not unit-tested: that the page draws a stamp the decoder reads. The page only
  // runs in Chromium; it was driven there with --test-pattern latency, and every
  // picture of a two-minute run decoded (DECKLINK.md, "Latency").
}
