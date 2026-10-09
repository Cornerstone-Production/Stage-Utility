import Foundation

/// Command-line flags. Parsed by hand: there are a handful and none is worth a
/// dependency.
public struct Options: Equatable {
  /// What `--test-pattern` shows instead of a server's screen.
  public enum TestPattern: String, Equatable, CaseIterable {
    /// `LatencyPage`: a clock to photograph, and a stamp the helper reads back.
    case latency
  }

  /// `--dump-frames <dir>`: write a PNG of every output every 5 s.
  public var dumpFramesDir: URL?
  /// `--show-window`: open the helper's window at launch (a menu bar app does not,
  /// otherwise, once it has been set up).
  public var showWindow = false
  /// `--list-outputs`: print each display's key, id and default, then exit.
  public var listOutputs = false
  /// `--discovery-port <n>`, else STAGE_KIOSK_PORT (the installer's variable), else 8789.
  /// The flag wins over the variable.
  public var discoveryPort: UInt16 = 8789
  /// `--log-stderr`: mirror the log to stderr.
  public var logToStderr = false
  /// `--virtual-sdi <n>`, for development: add n card outputs with no card behind
  /// them (`VirtualCards`), so the card path runs end to end on any Mac. 0 without it.
  public var virtualSDI = 0
  /// `--test-pattern latency`, for development: every output that is on shows the
  /// latency page instead of its server's screen (DECKLINK.md, "Latency").
  public var testPattern: TestPattern?
  /// `--frame-timings <file>`, for development: every card output's slots, one CSV
  /// line each, appended once a second (`FrameTimingCSV`).
  public var frameTimingsFile: URL?
  /// `--head-start <ms>` and `--fill-lead <ms>`, for development: when each card
  /// slot's picture is asked for and when the slot is filled, before air. Nil keeps
  /// the measured defaults.
  public var headStartMs: Double?
  public var fillLeadMs: Double?

  public init() {}

  public static let dumpInterval: TimeInterval = 5

  public static func parse(_ args: [String], environment: [String: String]) -> (Options, [String]) {
    var o = Options()
    var problems: [String] = []
    if let p = environment["STAGE_KIOSK_PORT"], !p.isEmpty {
      if let n = UInt16(p), n > 0 { o.discoveryPort = n } else { problems.append("STAGE_KIOSK_PORT is not a port: \(p)") }
    }
    var i = 1
    func value(_ flag: String) -> String? {
      guard i + 1 < args.count else { problems.append("\(flag) needs a value"); return nil }
      i += 1
      return args[i]
    }
    while i < args.count {
      switch args[i] {
      case "--dump-frames":
        if let v = value("--dump-frames") { o.dumpFramesDir = URL(fileURLWithPath: v, isDirectory: true) }
      case "--discovery-port":
        if let v = value("--discovery-port") {
          if let n = UInt16(v), n > 0 { o.discoveryPort = n } else { problems.append("--discovery-port is not a port: \(v)") }
        }
      case "--virtual-sdi":
        if let v = value("--virtual-sdi") {
          if let n = Int(v), (1...VirtualCards.maxCount).contains(n) {
            o.virtualSDI = n
          } else {
            problems.append("--virtual-sdi takes 1 to \(VirtualCards.maxCount): \(v)")
          }
        }
      case "--test-pattern":
        if let v = value("--test-pattern") {
          if let p = TestPattern(rawValue: v) {
            o.testPattern = p
          } else {
            problems.append("--test-pattern takes \(TestPattern.allCases.map(\.rawValue).joined(separator: ", ")): \(v)")
          }
        }
      case "--frame-timings":
        if let v = value("--frame-timings") { o.frameTimingsFile = URL(fileURLWithPath: v) }
      case "--head-start", "--fill-lead":
        let flag = args[i]
        if let v = value(flag) {
          if let ms = Double(v), ms > 0, ms < 1000 {
            if flag == "--head-start" { o.headStartMs = ms } else { o.fillLeadMs = ms }
          } else {
            problems.append("\(flag) takes milliseconds, more than 0 and less than 1000: \(v)")
          }
        }
      case "--show-window": o.showWindow = true
      case "--list-outputs": o.listOutputs = true
      case "--log-stderr": o.logToStderr = true
      default: problems.append("unknown argument: \(args[i])")
      }
      i += 1
    }
    if o.headStartMs != nil || o.fillLeadMs != nil,
      let problem = CardLeadLimits.problem(
        headStartMs: o.headStartMs ?? CardLeadLimits.standardHeadStartMs,
        fillLeadMs: o.fillLeadMs ?? CardLeadLimits.standardFillLeadMs)
    {
      problems.append(problem)
    }
    return (o, problems)
  }
}

/// When a card slot's picture is asked for and when the slot is filled, before air:
/// the standard leads, and what a pair of them must be to run at all. The shim's
/// DL_DEFAULT_HEAD_START_US, DL_DEFAULT_FILL_LEAD_US and DL_CARD_MIN_LEAD_US, which
/// the DeckLinkKit tests hold these equal to.
public enum CardLeadLimits {
  public static let standardHeadStartMs = 20.0
  public static let standardFillLeadMs = 5.0
  /// A fill that starts later than this before its slot is skipped: the card would
  /// show it late.
  public static let minFillLeadMs = 3.5

  /// Why `--head-start` and `--fill-lead` cannot run together, or nil. Refused when
  /// the flags are read, rather than leaving a port that never opens (a fill lead not
  /// shorter than the head start) or skips every slot (a fill lead under the card's
  /// need).
  public static func problem(headStartMs: Double, fillLeadMs: Double) -> String? {
    if fillLeadMs < minFillLeadMs {
      return "--fill-lead must be at least \(text(minFillLeadMs)) ms, the least before its slot a card takes a frame on time: \(text(fillLeadMs))"
    }
    if fillLeadMs >= headStartMs {
      return "--fill-lead (\(text(fillLeadMs)) ms) must be less than --head-start (\(text(headStartMs)) ms), or the page has no time to draw"
    }
    return nil
  }

  private static func text(_ ms: Double) -> String { String(format: "%g", ms) }
}
