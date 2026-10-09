import AppKit
import StageUtilityOutputCore
import WebKit

/// Where an output's pictures go. A display output is a window over a whole
/// display. Step 3 adds a DeckLink port, whose page is a visible window tiled on a
/// canvas display, with a tap that snapshots it on that display's refresh for the
/// card; a web view that is off screen or covered stops painting, so it is never
/// either. The web view itself, and everything about loading it, is the
/// `WebSurface`, which knows nothing of windows or screens.
@MainActor
protocol OutputDestination: AnyObject {
  /// Put the web view where this destination shows it.
  func attach(_ view: WKWebView)
  /// Counters since the last call, as the health post reports them.
  func takeHealthSample() -> HealthSample
  /// Turn the picture a quarter, half or three-quarter turn clockwise. A window
  /// lays the page out at the turned size and turns the view; a card will turn the
  /// frames it reads.
  func setRotation(_ rotation: Rotation)
  /// Stop showing and release whatever the destination holds.
  func detach()
}

/// An output that is a display: a web surface in a borderless window on one NSScreen.
@MainActor
final class DisplaySink {
  let descriptor: OutputDescriptor
  let surface: WebSurface
  private let destination: WindowDestination

  var keepPaintingProblems: [String] { surface.keepPaintingProblems }

  init(descriptor: OutputDescriptor, screen: NSScreen) {
    self.descriptor = descriptor
    surface = WebSurface(label: descriptor.port, size: screen.frame.size)
    destination = WindowDestination(placement: .fullScreen(of: screen))
    destination.attach(surface.webView)
  }

  func show(url: URL) { surface.show(url: url) }

  func stop() {
    surface.stop()
    destination.detach()
  }

  /// A hot-plug or a resolution change moved the display: follow it.
  func follow(_ screen: NSScreen) { destination.move(to: .fullScreen(of: screen)) }

  func takeHealthSample() -> HealthSample { destination.takeHealthSample() }

  /// Turn the picture, as the screen's `rotation` says.
  func setRotation(_ rotation: Rotation) { destination.setRotation(rotation) }

  /// Write what the output is showing to `file` as a PNG, turned the way the window
  /// shows it. `completion` gets nil on success, else why not.
  func writeSnapshot(to file: URL, completion: @escaping (String?) -> Void) {
    let rotation = destination.rotation
    surface.snapshot { image, problem in
      guard let image else {
        completion(problem)
        return
      }
      guard let turned = SnapshotTurn.turned(image, by: rotation),
        let png = NSBitmapImageRep(cgImage: turned).representation(using: .png, properties: [:])
      else {
        completion("could not encode the snapshot as a PNG")
        return
      }
      do {
        try png.write(to: file, options: .atomic)
        completion(nil)
      } catch {
        completion("could not write \(file.path): \(error.localizedDescription)")
      }
    }
  }
}

/// A snapshot comes from the web view, which draws the page upright at the size the
/// page laid out at. The window shows it turned; the dump should show what the
/// window shows.
enum SnapshotTurn {
  static func turned(_ image: CGImage, by rotation: Rotation) -> CGImage? {
    if rotation == .none { return image }
    let w = CGFloat(image.width)
    let h = CGFloat(image.height)
    let size = rotation.swapsAxes ? CGSize(width: h, height: w) : CGSize(width: w, height: h)
    guard
      let ctx = CGContext(
        data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    // CGContext angles are counterclockwise; the screen's turn is clockwise.
    ctx.translateBy(x: size.width / 2, y: size.height / 2)
    ctx.rotate(by: -CGFloat(rotation.rawValue) * .pi / 180)
    ctx.draw(image, in: CGRect(x: -w / 2, y: -h / 2, width: w, height: h))
    return ctx.makeImage()
  }
}
