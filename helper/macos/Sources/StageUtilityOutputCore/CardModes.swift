import Foundation

/// How a card mode's frames are made of fields.
public enum FieldOrder: Equatable {
  case progressive
  case upperFirst
  case lowerFirst
  /// Progressive segmented frame: a progressive picture sent as two fields.
  case segmented
  case unknown

  var isInterlaced: Bool { self == .upperFirst || self == .lowerFirst }
}

/// A display mode as a card's port reports it.
public struct CardMode: Equatable {
  /// The driver's code for it (a DeckLink `BMDDisplayMode`, 'Hp59').
  public var code: UInt32
  /// The driver's own name for it, for the log.
  public var driverName: String
  public var width: Int
  public var height: Int
  /// A frame lasts `frameDuration / timeScale` seconds. For an interlaced mode this
  /// is the frame of two fields, as DeckLink counts it: 1080i59.94 is 1001 / 30000.
  public var frameDuration: Int64
  public var timeScale: Int64
  public var field: FieldOrder
  /// The port plays it in 8-bit YUV 4:2:2, the only format the helper sends.
  public var supportsYUV8: Bool

  public init(
    code: UInt32, driverName: String, width: Int, height: Int, frameDuration: Int64, timeScale: Int64,
    field: FieldOrder, supportsYUV8: Bool
  ) {
    self.code = code
    self.driverName = driverName
    self.width = width
    self.height = height
    self.frameDuration = frameDuration
    self.timeScale = timeScale
    self.field = field
    self.supportsYUV8 = supportsYUV8
  }
}

/// Why a screen's mode cannot be played on a port.
public enum ModeRefusal: Error, Equatable {
  /// The server's list has no such mode. A newer server, or a hand-edited file.
  case unknown(String)
  /// The port reports no such mode. `offered` is what it does play.
  case notOnPort(String, offered: [String])
  /// The port has the mode, but not in 8-bit YUV.
  case noYUV(String)

  /// For the log and the window.
  public var reason: String {
    switch self {
    case .unknown(let mode):
      return "\(mode) is not a mode the helper knows"
    case .notOnPort(let mode, let offered):
      let list = offered.isEmpty ? "none the helper can send" : offered.joined(separator: ", ")
      return "the port has no \(mode) (it offers \(list))"
    case .noYUV(let mode):
      return "the port does not play \(mode) in 8-bit YUV"
    }
  }
}

/// The server's video mode names, and which of a port's modes each one is.
public enum VideoModes {
  /// Every mode a screen may be set to, sorted, one per line: the server's
  /// `VIDEO_MODES` in `main/types/output-format.ts`. A mode added there is added
  /// here, or the helper refuses it as unknown.
  public static let all = [
    "1080i50",
    "1080i59.94",
    "1080i60",
    "1080p23.98",
    "1080p24",
    "1080p25",
    "1080p29.97",
    "1080p30",
    "1080p50",
    "1080p59.94",
    "1080p60",
    "720p50",
    "720p59.94",
    "720p60",
  ]

  /// What a screen with no `videoMode` is sent as (`DEFAULT_VIDEO_MODE`).
  public static let defaultMode = "1080p59.94"

  /// The server's name for a port's mode ("1080p59.94"), or nil for a picture
  /// size or scan the server has no names for (2K DCI, UHD, SD, PsF).
  ///
  /// The name is worked out from the mode's size, scan and rate, not taken from the
  /// driver, whose wording is its own. The size must be the full 1920 x 1080 or
  /// 1280 x 720: 2K DCI is also 1080 lines, and is not "1080p24". An interlaced
  /// mode is named by its field rate, twice its frame rate.
  public static func name(of mode: CardMode) -> String? {
    let lines: String
    switch (mode.width, mode.height) {
    case (1920, 1080): lines = "1080"
    case (1280, 720): lines = "720"
    default: return nil
    }
    let scan: String
    switch mode.field {
    case .progressive: scan = "p"
    case .upperFirst, .lowerFirst: scan = "i"
    case .segmented, .unknown: return nil
    }
    guard mode.frameDuration > 0, mode.timeScale > 0 else { return nil }
    let rate = Double(mode.timeScale) / Double(mode.frameDuration) * (mode.field.isInterlaced ? 2 : 1)
    return "\(lines)\(scan)\(rateText(rate))"
  }

  /// "59.94", "60", "23.98": to two places, without a trailing zero.
  public static func rateText(_ rate: Double) -> String {
    let hundredths = Int((rate * 100).rounded())
    if hundredths % 100 == 0 { return "\(hundredths / 100)" }
    let text = String(format: "%d.%02d", hundredths / 100, hundredths % 100)
    return text.hasSuffix("0") ? String(text.dropLast()) : text
  }

  /// Every mode in `all`, as a card that played them all in 8-bit YUV would report
  /// it: what a virtual port (`--virtual-sdi`) offers. The timings are DeckLink's
  /// (DECKLINK.md, Formats); `code` is 0, as no driver is asked.
  public static let standard: [CardMode] = all.compactMap(standardMode(named:))

  /// The mode a server name describes, or nil for a name that is not one.
  public static func standardMode(named name: String) -> CardMode? {
    let size: (Int, Int)
    let rest: Substring
    if name.hasPrefix("1080") {
      size = (1920, 1080)
      rest = name.dropFirst(4)
    } else if name.hasPrefix("720") {
      size = (1280, 720)
      rest = name.dropFirst(3)
    } else {
      return nil
    }
    guard let scan = rest.first, scan == "p" || scan == "i" else { return nil }
    // Frames per second as duration / scale. An interlaced name is its field rate:
    // its frames come at half of it.
    let rates: [String: (Int64, Int64)] = [
      "23.98": (1001, 24000), "24": (1000, 24000), "25": (1000, 25000), "29.97": (1001, 30000),
      "30": (1000, 30000), "50": (1000, 50000), "59.94": (1001, 60000), "60": (1000, 60000),
    ]
    guard let (duration, rateScale) = rates[String(rest.dropFirst())] else { return nil }
    let scale = scan == "i" ? rateScale / 2 : rateScale
    let mode = CardMode(
      code: 0, driverName: name, width: size.0, height: size.1, frameDuration: duration, timeScale: scale,
      field: scan == "i" ? .upperFirst : .progressive, supportsYUV8: true)
    return VideoModes.name(of: mode) == name ? mode : nil
  }

  /// The modes a port can be set to, for the probe's `modes`: the server's names it
  /// plays in 8-bit YUV, in the server's order.
  public static func offered(by modes: [CardMode]) -> [String] {
    let names = Set(modes.filter(\.supportsYUV8).compactMap(name(of:)))
    return all.filter(names.contains)
  }

  /// A screen's `videoMode` as the helper keeps it: surrounding whitespace dropped,
  /// and nothing left (or nothing given) is nil, the default. Every place that reads
  /// a format reads it through this, so " 720p59.94" from one and "720p59.94" from
  /// another are one format, not a change.
  public static func normalised(_ mode: String?) -> String? {
    let trimmed = mode?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? nil : trimmed
  }

  /// The mode a screen's `videoMode` asks for: the default when it has none.
  public static func effective(_ mode: String?) -> String { normalised(mode) ?? defaultMode }

  /// The port's mode for a screen's `videoMode`: the default when it has none, and
  /// a reason when the port cannot play it.
  public static func resolve(_ requested: String?, among modes: [CardMode]) -> Result<CardMode, ModeRefusal> {
    let want = effective(requested)
    guard all.contains(want) else { return .failure(.unknown(want)) }
    let matching = modes.filter { name(of: $0) == want }
    if matching.isEmpty { return .failure(.notOnPort(want, offered: offered(by: modes))) }
    guard let mode = matching.first(where: \.supportsYUV8) else { return .failure(.noYUV(want)) }
    return .success(mode)
  }
}
