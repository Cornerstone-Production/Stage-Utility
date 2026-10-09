import AppKit
import StageUtilityOutputCore
import WebKit

/// Where an output's pictures go. A display is a full-screen window; step 3 adds a
/// DeckLink port, whose destination keeps the web view off every display and reads
/// its frames for a card. The web view itself, and everything about loading it, is
/// the `WebSurface`.
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
    destination = WindowDestination(screen: screen)
    destination.attach(surface.webView)
  }

  func show(url: URL) { surface.show(url: url) }

  func stop() {
    surface.stop()
    destination.detach()
  }

  /// A hot-plug or a resolution change moved the display: follow it.
  func follow(_ screen: NSScreen) { destination.follow(screen) }

  func takeHealthSample() -> HealthSample { destination.takeHealthSample() }

  func writeSnapshot(to file: URL, completion: @escaping (String?) -> Void) {
    surface.writeSnapshot(to: file, completion: completion)
  }
}
