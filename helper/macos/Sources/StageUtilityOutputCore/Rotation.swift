import CoreGraphics
import Foundation

/// How far a screen's picture is turned clockwise, for a monitor mounted on its
/// side: the `rotation` of a screen on the server (0, 90, 180 or 270; absent is 0).
/// Clockwise, like CSS `rotate()`, which the server's own preview uses.
public enum Rotation: Int, Equatable, Sendable {
  case none = 0
  case clockwise90 = 90
  case clockwise180 = 180
  case clockwise270 = 270

  /// The value the server holds, or `.none` for anything else: absent, null, or a
  /// number that is not a quarter turn. The server refuses those at the PATCH, so
  /// seeing one means an older or newer server, and an upright picture is the
  /// safe reading.
  public init(serverValue: Any?) {
    if let n = serverValue as? NSNumber, n.doubleValue == n.doubleValue.rounded(), let r = Rotation(rawValue: n.intValue) {
      self = r
    } else {
      self = .none
    }
  }

  /// A quarter or three quarters turns the picture on its side, so the page has to
  /// be laid out at the window's height by its width.
  public var swapsAxes: Bool { self == .clockwise90 || self == .clockwise270 }

  /// Where the page's view goes inside a window of this size, and how it is turned
  /// about its centre.
  ///
  /// The view's size is what the PAGE lays out at: for a window 1920 x 1080
  /// turned a quarter it is 1080 x 1920, so the page draws a portrait screen that
  /// the turn then lays flat across the window. Its frame is centred on the
  /// window's centre, which is what a rotation about its own centre needs.
  public func layout(inWindow window: CGSize) -> SurfaceLayout {
    let size = swapsAxes ? CGSize(width: window.height, height: window.width) : window
    let frame = CGRect(
      x: (window.width - size.width) / 2, y: (window.height - size.height) / 2, width: size.width, height: size.height)
    return SurfaceLayout(frame: frame, clockwiseDegrees: Double(rawValue))
  }
}

public struct SurfaceLayout: Equatable {
  /// The page's view's frame in the window's coordinates, before it is turned.
  public var frame: CGRect
  public var clockwiseDegrees: Double
}
