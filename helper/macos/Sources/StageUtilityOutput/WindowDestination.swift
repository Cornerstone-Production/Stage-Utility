import AppKit
import QuartzCore
import StageUtilityOutputCore
import WebKit

/// A borderless window covering one display, with the web view as its content.
@MainActor
final class WindowDestination: NSObject, OutputDestination {
  private var window: NSWindow?
  private var link: CADisplayLink?
  private var ticks = 0
  private var sampleStart = CACurrentMediaTime()
  private let initialScreen: NSScreen

  init(screen: NSScreen) {
    initialScreen = screen
    super.init()
  }

  func attach(_ view: WKWebView) {
    let screen = initialScreen
    let win = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false, screen: screen)
    win.isReleasedWhenClosed = false
    win.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 1)
    win.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    win.backgroundColor = .black
    win.hasShadow = false
    win.hidesOnDeactivate = false
    win.contentView = view
    win.setFrame(screen.frame, display: true)
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

  func follow(_ screen: NSScreen) {
    guard let window else { return }
    if window.frame != screen.frame { window.setFrame(screen.frame, display: true) }
    if window.screen != screen {
      // The old display link belongs to the old screen.
      startLink(on: screen)
    }
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
