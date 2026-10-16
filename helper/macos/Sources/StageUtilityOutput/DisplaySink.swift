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
  /// out. `completion` gets what became of it.
  func writeSnapshot(to file: URL, completion: @escaping @MainActor (FrameDumpOutcome) -> Void)
}

extension OutputSink {
  /// What the engine could not set up, worded for the log and the window.
  var surfaceProblems: [String] { surface.problems }

  func show(url: URL) { surface.load(url) }
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

  func stop() {
    surface.stop()
    destination.detach()
  }

  /// A hot-plug or a resolution change moved the display: follow it.
  func follow(_ screen: NSScreen) { destination.move(to: .fullScreen(of: screen)) }

  func takeHealthSample() -> HealthSample { destination.takeHealthSample() }

  func setRotation(_ rotation: Rotation) { destination.setRotation(rotation) }

  func writeSnapshot(to file: URL, completion: @escaping @MainActor (FrameDumpOutcome) -> Void) {
    SnapshotTurn.write(surface, turnedBy: destination.rotation, to: file) { why in
      completion(why.map(FrameDumpOutcome.failed) ?? .written)
    }
  }
}

/// A picture as a PNG file, which every `--dump-frames` picture is.
enum PNGFile {
  /// Write `image` to `file` atomically. Nil on success, else why not; `what` names
  /// the picture in the reason. A nil `image` is one that could not be made.
  static func write(_ image: CGImage?, to file: URL, called what: String) -> String? {
    guard let image, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
      return "could not encode \(what) as a PNG"
    }
    do {
      try png.write(to: file, options: .atomic)
      return nil
    } catch {
      return "could not write \(file.path): \(error.localizedDescription)"
    }
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
  static func write(
    _ surface: WebSurface, turnedBy rotation: Rotation, to file: URL, completion: @escaping @MainActor (String?) -> Void
  ) {
    surface.snapshot { image, problem in
      guard let image else {
        completion(problem)
        return
      }
      let done: @Sendable (String?) -> Void = { why in
        DispatchQueue.main.async { MainActor.assumeIsolated { completion(why) } }
      }
      DispatchQueue.global(qos: .utility).async {
        done(PNGFile.write(turned(image, by: rotation), to: file, called: "the snapshot"))
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
