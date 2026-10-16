import AppKit
import QuartzCore
import StageUtilityOutputCore

/// Where a window goes: a rectangle, in screen coordinates, on one display.
///
/// A display output takes the whole display. A placement is a rectangle rather than
/// a screen so that a window could later take part of one; nothing here assumes a
/// window is a whole screen.
struct WindowPlacement: Equatable {
  var screen: NSScreen
  var frame: NSRect

  static func fullScreen(of screen: NSScreen) -> WindowPlacement {
    WindowPlacement(screen: screen, frame: screen.frame)
  }
}

/// The window's content: a black field holding the surface's host view, which it
/// lays out at the size the turn needs and turns about its centre. Nothing here knows
/// what draws inside the host view.
///
/// The turn is the view's `frameCenterRotation`, not a transform on a layer inside
/// it: AppKit then does the hit-testing in the turned view's own coordinates. A
/// surface's snapshot draws the page upright whatever the view's turn, so a snapshot
/// is turned afterwards to match (see `SnapshotTurn`).
@MainActor
private final class TurnedSurfaceView: NSView {
  var rotation: Rotation = .none {
    didSet {
      if rotation != oldValue { needsLayout = true }
    }
  }
  private let surface: NSView

  init(surface: NSView) {
    self.surface = surface
    super.init(frame: .zero)
    surface.autoresizingMask = []
    addSubview(surface)
  }

  required init?(coder: NSCoder) { fatalError("not made from a nib") }

  override func layout() {
    super.layout()
    let l = rotation.layout(inWindow: bounds.size)
    // Un-turn before setting a frame: a turned view's frame is its bounding box.
    surface.frameCenterRotation = 0
    surface.frame = l.frame
    // AppKit turns a non-flipped view counterclockwise for a positive angle.
    surface.frameCenterRotation = CGFloat(-l.clockwiseDegrees)
  }
}

/// A borderless window at a placement, with the surface's host view as its content,
/// and what the window counts. The page itself, and everything about loading it, is
/// the `WebSurface`, which knows nothing of windows or screens, nor which engine
/// draws it.
@MainActor
final class WindowDestination: NSObject {
  private var window: NSWindow?
  private var link: CADisplayLink?
  private var ticks = 0
  private var sampleStart = CACurrentMediaTime()
  private var placement: WindowPlacement
  private var turned: TurnedSurfaceView?
  private(set) var rotation: Rotation = .none

  init(placement: WindowPlacement) {
    self.placement = placement
    super.init()
  }

  func attach(_ view: NSView) {
    let screen = placement.screen
    let win = NSWindow(contentRect: placement.frame, styleMask: .borderless, backing: .buffered, defer: false, screen: screen)
    win.isReleasedWhenClosed = false
    win.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 1)
    win.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    win.backgroundColor = .black
    win.hasShadow = false
    win.hidesOnDeactivate = false
    let field = TurnedSurfaceView(surface: view)
    field.rotation = rotation
    turned = field
    win.contentView = field
    win.setFrame(placement.frame, display: true)
    win.orderFrontRegardless()
    window = win
    startLink(on: screen)
  }

  /// Turn the picture a quarter, half or three-quarter turn clockwise: the page is
  /// laid out at the turned size and the view turned.
  func setRotation(_ new: Rotation) {
    rotation = new
    turned?.rotation = new
  }

  func detach() {
    link?.invalidate()
    link = nil
    window?.orderOut(nil)
    window?.close()
    window = nil
    turned = nil
  }

  /// The display moved or changed size: follow it.
  func move(to new: WindowPlacement) {
    let screenChanged = new.screen != placement.screen
    placement = new
    guard let window else { return }
    if window.frame != new.frame { window.setFrame(new.frame, display: true) }
    // The old display link belongs to the old screen.
    if screenChanged || window.screen != new.screen { startLink(on: new.screen) }
  }

  /// Counters since the last call, as the health post reports them.
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
