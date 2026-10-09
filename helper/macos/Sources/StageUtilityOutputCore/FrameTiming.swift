import Foundation

/// What became of one slot of a card output, with the times of its picture on the
/// way, as the DeckLink scheduler records them. Host time in nanoseconds
/// (mach_absolute_time, `DispatchTime.uptimeNanoseconds`), 0 where unknown.
public struct FrameTiming: Equatable, Sendable {
  public var index: Int64
  /// A new picture; false for a repeat of the one before, whose times it carries.
  public var fresh: Bool
  /// Nothing of ours went out in this slot: the card held its previous picture.
  public var skipped: Bool
  /// The card's report: 0 completed, 1 displayed late, 2 dropped.
  public var result: Int
  /// When the picture's content was drawn: the page's begin frame.
  public var contentNs: UInt64
  /// When the page handed the picture over.
  public var paintNs: UInt64
  /// When the picture was converted and ready to copy into a frame.
  public var readyNs: UInt64
  /// When the slot's fill began (the fill lead before air), when the picture was in
  /// the frame, and when the card had taken it.
  public var fillNs: UInt64
  public var copiedNs: UInt64
  public var scheduledNs: UInt64
  /// When the slot began going out of the card, on the host clock.
  public var airNs: UInt64
  /// When the card said it had finished with the frame: the end of its slot.
  public var completedNs: UInt64

  public init(
    index: Int64, fresh: Bool = true, skipped: Bool = false, result: Int = 0, contentNs: UInt64 = 0,
    paintNs: UInt64 = 0, readyNs: UInt64 = 0, fillNs: UInt64 = 0, copiedNs: UInt64 = 0, scheduledNs: UInt64 = 0,
    airNs: UInt64 = 0,
    completedNs: UInt64 = 0
  ) {
    self.index = index
    self.fresh = fresh
    self.skipped = skipped
    self.result = result
    self.contentNs = contentNs
    self.paintNs = paintNs
    self.readyNs = readyNs
    self.fillNs = fillNs
    self.copiedNs = copiedNs
    self.scheduledNs = scheduledNs
    self.airNs = airNs
    self.completedNs = completedNs
  }

  /// From the picture's content being drawn to the slot going out of the card:
  /// how far behind real time the output runs. Nil when either end is unknown.
  public var renderToAirMs: Double? { Self.ms(from: contentNs, to: airNs) }

  static func ms(from a: UInt64, to b: UInt64) -> Double? {
    guard a > 0, b > 0 else { return nil }
    return (Double(b) - Double(a)) / 1e6
  }
}

/// The middle and the tail of a set of measurements.
public struct Distribution: Equatable, Sendable {
  public var count: Int
  public var p50: Double
  public var p95: Double
  public var max: Double

  public init(count: Int, p50: Double, p95: Double, max: Double) {
    self.count = count
    self.p50 = p50
    self.p95 = p95
    self.max = max
  }

  /// Nearest-rank percentiles. Nil for no values.
  public static func of(_ values: [Double]) -> Distribution? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    func rank(_ p: Double) -> Double { sorted[Swift.max(0, Int((p * Double(sorted.count)).rounded(.up)) - 1)] }
    return Distribution(count: sorted.count, p50: rank(0.5), p95: rank(0.95), max: sorted.last!)
  }

  /// "28.7 ms (p95 29.4, max 31.0)".
  public var text: String { String(format: "%.1f ms (p95 %.1f, max %.1f)", p50, p95, max) }
}

/// Where a card output's delay goes, stage by stage, over a set of new pictures that
/// went out: the measurement DECKLINK.md's latency budget is made of.
public struct LatencyBreakdown: Equatable, Sendable {
  /// The whole: content drawn to the slot going out.
  public var renderToAir: Distribution?
  /// Chromium: content drawn to the picture handed over.
  public var contentToPaint: Distribution?
  /// The conversion to UYVY, from the picture handed over to ready.
  public var paintToReady: Distribution?
  /// Waiting for the slot's fill: ready to filled.
  public var readyToFill: Distribution?
  /// The copy into the frame.
  public var fillToCopied: Distribution?
  /// The card taking the frame (the driver's own copy across the bus).
  public var copiedToScheduled: Distribution?
  /// In the card's queue: handed over to the slot beginning.
  public var scheduledToAir: Distribution?
  /// The slot itself: from beginning to the card finishing with it.
  public var airToCompleted: Distribution?

  /// Over the new pictures in `timings` that went out; repeats and skips carry no
  /// new content and are left out.
  public static func of(_ timings: [FrameTiming]) -> LatencyBreakdown {
    let sent = timings.filter { $0.fresh && !$0.skipped }
    func d(_ from: KeyPath<FrameTiming, UInt64>, _ to: KeyPath<FrameTiming, UInt64>) -> Distribution? {
      Distribution.of(sent.compactMap { FrameTiming.ms(from: $0[keyPath: from], to: $0[keyPath: to]) })
    }
    return LatencyBreakdown(
      renderToAir: d(\.contentNs, \.airNs), contentToPaint: d(\.contentNs, \.paintNs),
      paintToReady: d(\.paintNs, \.readyNs), readyToFill: d(\.readyNs, \.fillNs),
      fillToCopied: d(\.fillNs, \.copiedNs), copiedToScheduled: d(\.copiedNs, \.scheduledNs),
      scheduledToAir: d(\.scheduledNs, \.airNs),
      airToCompleted: d(\.airNs, \.completedNs))
  }
}

/// When a card output's render-to-air latency is worth a log line: the first time
/// it is measured, and when it has moved by `change` or more since the line before.
/// A health window's median moves by a fraction of a millisecond from one to the
/// next; a line for that would be noise, but a frame's worth of change means the
/// page or the machine has changed what it costs.
public enum LatencyLog {
  public static let change = 4.0

  public static func worthSaying(_ latencyMs: Double, after logged: Double?) -> Bool {
    guard let logged else { return true }
    return abs(latencyMs - logged) >= change
  }
}

/// `--frame-timings`: a card output's slots as CSV, one line each, every time in
/// nanoseconds on the host clock (0 where unknown), for working out a latency
/// budget away from the Mac.
public enum FrameTimingCSV {
  public static let header =
    "output,index,fresh,skipped,result,content_ns,paint_ns,ready_ns,fill_ns,copied_ns,scheduled_ns,air_ns,completed_ns"

  public static func line(output: String, _ t: FrameTiming) -> String {
    let fields: [String] = [
      output, "\(t.index)", t.fresh ? "1" : "0", t.skipped ? "1" : "0", "\(t.result)", "\(t.contentNs)", "\(t.paintNs)",
      "\(t.readyNs)", "\(t.fillNs)", "\(t.copiedNs)", "\(t.scheduledNs)", "\(t.airNs)", "\(t.completedNs)",
    ]
    return fields.joined(separator: ",")
  }
}
