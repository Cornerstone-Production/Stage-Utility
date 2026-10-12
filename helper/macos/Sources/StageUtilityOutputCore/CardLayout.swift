import Foundation

/// A size in pixels.
public struct PixelSize: Equatable, Hashable, Sendable, CustomStringConvertible {
  public var width: Int
  public var height: Int

  public init(width: Int, height: Int) {
    self.width = width
    self.height = height
  }

  public var swapped: PixelSize { PixelSize(width: height, height: width) }
  public var description: String { "\(width)x\(height)" }
}

/// The size a card output's page lays out at: the port's frame size, portrait for a
/// quarter turn.
///
/// Decided from what the port reports each time it opens (the first time, on a retry,
/// in a new format) and from the screen's rotation, never from what was asked for: a
/// port that cannot open yet has no frame size, and a format asked for while the
/// port is lost takes effect only when the port opens in it. Laying out from the
/// port's size when the format was asked for left a page that opened late at no
/// size, and one reopened in another format at the old one.
public struct CardPageLayout: Equatable {
  /// The port's frame size, from its last open; nil before it has opened.
  public private(set) var frame: PixelSize?
  public private(set) var rotation: Rotation = .none
  /// What the page is laid out at now.
  public private(set) var page: PixelSize

  /// A page made at `size`, before its port has said anything.
  public init(pageMadeAt size: PixelSize) { page = size }

  /// The port opened with frames of `size`. The size to lay the page out at, or nil
  /// when it is laid out at it already.
  public mutating func portOpened(_ size: PixelSize) -> PixelSize? {
    frame = size
    return relayout()
  }

  /// The screen's rotation changed. The page's new size, or nil when it keeps its own
  /// (a half turn, or no port open yet).
  public mutating func turned(_ new: Rotation) -> PixelSize? {
    rotation = new
    return relayout()
  }

  private mutating func relayout() -> PixelSize? {
    guard let frame else { return nil }
    let wanted = rotation.swapsAxes ? frame.swapped : frame
    guard wanted != page else { return nil }
    page = wanted
    return wanted
  }
}
