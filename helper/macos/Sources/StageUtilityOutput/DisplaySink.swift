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

  func writeSnapshot(to file: URL, completion: @escaping (String?) -> Void) {
    surface.writeSnapshot(to: file, completion: completion)
  }
}
