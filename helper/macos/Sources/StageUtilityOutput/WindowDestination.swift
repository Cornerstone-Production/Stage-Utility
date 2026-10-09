import AppKit
import QuartzCore
import StageUtilityOutputCore
import WebKit

/// Where a window goes: a rectangle, in screen coordinates, on one display.
///
/// A display output takes the whole display. A DeckLink output will take a tile of
/// a canvas display, one of several windows on it, so nothing here may assume that
/// a window is a whole screen.
struct WindowPlacement: Equatable {
  var screen: NSScreen
  var frame: NSRect

  static func fullScreen(of screen: NSScreen) -> WindowPlacement {
    WindowPlacement(screen: screen, frame: screen.frame)
  }
}

/// A borderless window at a placement, with the web view as its content.
@MainActor
final class WindowDestination: NSObject, OutputDestination {
  private var window: NSWindow?
  private var link: CADisplayLink?
  private var ticks = 0
  private var sampleStart = CACurrentMediaTime()
  private var placement: WindowPlacement

  init(placement: WindowPlacement) {
    self.placement = placement
    super.init()
  }

  func attach(_ view: WKWebView) {
    let screen = placement.screen
    let win = NSWindow(contentRect: placement.frame, styleMask: .borderless, backing: .buffered, defer: false, screen: screen)
    win.isReleasedWhenClosed = false
    win.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 1)
    win.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    win.backgroundColor = .black
    win.hasShadow = false
    win.hidesOnDeactivate = false
    win.contentView = view
    win.setFrame(placement.frame, display: true)
    win.orderFrontRegardless()
    window = win
    startLink(on: screen)
  }

  func detach() {
    link?.invalidate()
    link = nil
    window?.orderOut(nil)
    window?.close()
    window = nil
  }

  /// The display moved or changed size, or the tile did: follow it.
  func move(to new: WindowPlacement) {
    let screenChanged = new.screen != placement.screen
    placement = new
    guard let window else { return }
    if window.frame != new.frame { window.setFrame(new.frame, display: true) }
    // The old display link belongs to the old screen.
    if screenChanged || window.screen != new.screen { startLink(on: new.screen) }
  }

  func takeHealthSample() -> HealthSample {
    let now = CACurrentMediaTime()
    let elapsed = now - sampleStart
    let fps = elapsed > 0 ? Double(ticks) / elapsed : 0
    ticks = 0
    sampleStart = now
    // A window cannot repeat or drop a frame the way a card's schedule can.
    return HealthSample(fps: fps, repeated: 0, dropped: 0)
  }

  // MARK: Display link

  private func startLink(on screen: NSScreen) {
    link?.invalidate()
    let l = screen.displayLink(target: self, selector: #selector(tick(_:)))
    l.add(to: .main, forMode: .common)
    link = l
    ticks = 0
    sampleStart = CACurrentMediaTime()
  }

  @objc private func tick(_ link: CADisplayLink) { ticks += 1 }
}
