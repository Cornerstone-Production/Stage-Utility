import AppKit
import StageUtilityOutputCore

/// One output the helper drives: a page, and where its pictures go. A display output
/// (`DisplaySink`) is a window over a display; a card output (`CardOutput`) is a
/// windowless page whose frames go to a card on the card's clock.
@MainActor
protocol OutputSink: AnyObject {
  var descriptor: OutputDescriptor { get }
  var surface: WebSurface { get }
  func show(url: URL)
  func stop()
  /// Counters since the last call, as the health post reports them.
  func takeHealthSample() -> HealthSample
  /// Turn the picture, as the screen's `rotation` says.
  func setRotation(_ rotation: Rotation)
  /// Write what the output is showing to `file` as a PNG, turned the way it goes
  /// out. `completion` gets nil on success, else why not.
  func writeSnapshot(to file: URL, completion: @escaping (String?) -> Void)
}

extension OutputSink {
  /// What the engine could not set up, worded for the log and the window.
  var surfaceProblems: [String] { surface.problems }
}

/// Where a display output's window goes, and what it counts. The page itself, and
/// everything about loading it, is the `WebSurface`, which knows nothing of windows
/// or screens, nor which engine draws it.
@MainActor
protocol OutputDestination: AnyObject {
  /// Put the surface's host view where this destination shows it.
  func attach(_ view: NSView)
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
final class DisplaySink: OutputSink {
  let descriptor: OutputDescriptor
  let surface: WebSurface
  private let destination: WindowDestination

  init(descriptor: OutputDescriptor, screen: NSScreen) {
    self.descriptor = descriptor
    surface = WebSurfaces.windowed(label: descriptor.port, size: screen.frame.size)
    destination = WindowDestination(placement: .fullScreen(of: screen))
    destination.attach(surface.hostView)
  }

  func show(url: URL) { surface.load(url) }

  func stop() {
    surface.stop()
    destination.detach()
  }

  /// A hot-plug or a resolution change moved the display: follow it.
  func follow(_ screen: NSScreen) { destination.move(to: .fullScreen(of: screen)) }

  func takeHealthSample() -> HealthSample { destination.takeHealthSample() }

  func setRotation(_ rotation: Rotation) { destination.setRotation(rotation) }

  func writeSnapshot(to file: URL, completion: @escaping (String?) -> Void) {
    SnapshotTurn.write(surface, turnedBy: destination.rotation, to: file, completion: completion)
  }
}

/// A display output's snapshot comes from the page, drawn upright at the size the
/// page laid out at. The window shows it turned; the dump should show what the
/// window shows. (A card output's dump is its frame, already turned: `CardDump`.)
enum SnapshotTurn {
  /// The picture is taken on the main thread; turning, encoding and writing it are
  /// not. Card outputs get their pictures on the main thread, and a 1080p PNG encode
  /// there held them up long enough to repeat a frame. `completion` runs on the main
  /// thread.
  @MainActor
  static func write(_ surface: WebSurface, turnedBy rotation: Rotation, to file: URL, completion: @escaping (String?) -> Void) {
    surface.snapshot { image, problem in
      guard let image else {
        completion(problem)
        return
      }
      let done: @Sendable (String?) -> Void = { why in DispatchQueue.main.async { completion(why) } }
      DispatchQueue.global(qos: .utility).async {
        guard let turned = turned(image, by: rotation),
          let png = NSBitmapImageRep(cgImage: turned).representation(using: .png, properties: [:])
        else {
          done("could not encode the snapshot as a PNG")
          return
        }
        do {
          try png.write(to: file, options: .atomic)
          done(nil)
        } catch {
          done("could not write \(file.path): \(error.localizedDescription)")
        }
      }
    }
  }

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
