import AppKit
import StageUtilityOutputCore

/// A page, whatever renders it: Chromium through CEF, windowed for a display
/// (`CEFWindowedSurface`) or windowless for a card (`CEFWindowlessSurface`). Nothing
/// above this protocol (a destination, a sink, the model) names an engine.
///
/// The engine reports what happened to a navigation; the retry, the backoff and the
/// reading of a 5xx are `SurfaceLoader`, which every engine shares.
@MainActor
protocol WebSurface: AnyObject {
  /// The view the page is drawn in, for a destination to place. For a surface that
  /// draws off screen this is a view that is never shown.
  var hostView: NSView { get }
  /// What the engine could not set up, each worded for the log and the window. Empty
  /// when everything took.
  var problems: [String] { get }
  /// How a load ended. `failures` is the run of consecutive failures (0 on success).
  var onLoadResult: (@MainActor (_ failures: Int) -> Void)? { get set }
  /// A page committed: the URL now on the screen, after the server's redirect from
  /// /enroll to the screen. Never for a 5xx page, a load still in flight or one that
  /// failed.
  var onCommitted: (@MainActor (URL) -> Void)? { get set }
  /// The page's renderer process ended (crashed, killed, out of memory), and why.
  /// The surface reloads it by itself; this is for telling the operator.
  var onProcessGone: (@MainActor (String) -> Void)? { get set }
  /// Show this address. The same address again does nothing.
  func load(_ url: URL)
  /// Load the current address again now.
  func reload()
  /// What the surface is showing, as the page draws it: before any turn a window
  /// gives it. Gets the picture, or why there is none.
  func snapshot(completion: @escaping @MainActor (CGImage?, String?) -> Void)
  func stop()
}

/// The part of loading that is the same in every engine: the address asked for, the
/// run of failures, the reload after a wait, and what a 5xx means. The engine calls
/// the events; this calls `navigate` and the callbacks.
///
@MainActor
final class SurfaceLoader {
  var onLoadResult: (@MainActor (_ failures: Int) -> Void)?
  var onCommitted: (@MainActor (URL) -> Void)?
  var onProcessGone: (@MainActor (String) -> Void)?

  private let label: String
  private let navigate: @MainActor (URL) -> Void
  private var tracker = PageLoadTracker()
  private var requested: URL?
  private var reloadWork: DispatchWorkItem?

  /// `navigate` starts the engine loading an address.
  init(label: String, navigate: @escaping @MainActor (URL) -> Void) {
    self.label = label
    self.navigate = navigate
  }

  func show(_ url: URL) {
    if requested == url { return }
    requested = url
    tracker.reset()
    reload()
  }

  func reload() {
    guard let requested else { return }
    reloadWork?.cancel()
    tracker.loadStarted()
    navigate(requested)
  }

  func stop() {
    reloadWork?.cancel()
    reloadWork = nil
    requested = nil
  }

  // MARK: What the engine reports

  func responded(status: Int) { apply(tracker.responded(status: status)) }

  /// A page committed at `url`. A 5xx page is on the screen too, but its URL says
  /// nothing about whether the output is set up, so it is not reported.
  func committed(_ url: URL) {
    guard !tracker.responseFailed else { return }
    onCommitted?(url)
  }

  func finished() { apply(tracker.finished()) }
  func failed(_ error: NSError) { apply(tracker.navigationFailed(error)) }
  func processEnded(_ why: String) {
    onProcessGone?(why)
    apply(tracker.processTerminated())
  }

  private func apply(_ outcome: PageLoadTracker.Outcome) {
    switch outcome {
    case .none:
      return
    case .failed(let f):
      Log.error(.output, "\(label): page did not load (\(f.reason)); reload \(f.failures) in \(Int(f.delay)) s")
      onLoadResult?(f.failures)
      reloadWork?.cancel()
      let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.reload() } }
      reloadWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + f.delay, execute: work)
    case .loaded(let afterFailures):
      if afterFailures > 0 { Log.notice(.output, "\(label): page loaded again after \(afterFailures) failures") }
      onLoadResult?(0)
    }
  }
}

/// Stands in for a page when Chromium could not start: it draws black and loads
/// nothing. The reason is said once, for the whole app (`CEFEngine.failure`), not
/// once per output.
@MainActor
final class DeadSurface: WebSurface {
  let hostView: NSView
  let problems: [String] = []
  var onLoadResult: (@MainActor (Int) -> Void)?
  var onCommitted: (@MainActor (URL) -> Void)?
  var onProcessGone: (@MainActor (String) -> Void)?

  init(size: CGSize) {
    hostView = NSView(frame: NSRect(origin: .zero, size: size))
    hostView.wantsLayer = true
    hostView.layer?.backgroundColor = NSColor.black.cgColor
  }

  func load(_ url: URL) {}
  func reload() {}
  func stop() {}
  func snapshot(completion: @escaping @MainActor (CGImage?, String?) -> Void) {
    completion(nil, "no picture: Chromium did not start")
  }
}

enum WebSurfaces {
  /// Why no output can draw, worded for the window.
  static func unavailable(_ why: String) -> String { "Chromium did not start, so no output can show a screen: \(why)." }

  /// A display output's page. The only place that picks an engine for one.
  @MainActor
  static func windowed(label: String, size: CGSize) -> WebSurface {
    guard let api = CEFEngine.api else { return DeadSurface(size: size) }
    return CEFWindowedSurface(api: api, label: label, size: size)
  }
}
