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
  /// Asked when a load fails, for what the rest of the app knows about Local Network
  /// access since the run of failures began (`UnreachablePage.Evidence`). Unset is
  /// no evidence.
  var localNetworkEvidence: (@MainActor (_ since: Date) -> UnreachablePage.Evidence)? { get set }
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
/// run of failures, the reload after a wait, what a 5xx means, and the page shown in
/// place of a failed load. The engine calls the events; this calls `navigate` and the
/// callbacks.
@MainActor
final class SurfaceLoader {
  var onLoadResult: (@MainActor (_ failures: Int) -> Void)?
  var onCommitted: (@MainActor (URL) -> Void)?
  var onProcessGone: (@MainActor (String) -> Void)?
  var localNetworkEvidence: (@MainActor (_ since: Date) -> UnreachablePage.Evidence)?

  private let label: String
  private let navigate: @MainActor (URL) -> Void
  private var tracker = PageLoadTracker()
  private var requested: URL?
  private var reloadWork: DispatchWorkItem?
  /// When the current run of failures began.
  private var failingSince: Date?

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
  /// nothing about whether the output is set up, so it is not reported; nor is the
  /// helper's own page for a failed load, even when its commit arrives after a
  /// reload has begun.
  func committed(_ url: URL) {
    guard tracker.reportsCommit, url.scheme != "data" else { return }
    onCommitted?(url)
  }

  func finished() { apply(tracker.finished()) }

  /// A navigation failed. Every Chromium net error is replaced on the screen by
  /// `UnreachablePage`, whether or not it counts as a new failure (the one after a
  /// 5xx does not): the browser host has hidden Chromium's own error page, which
  /// prints the address and its token, and shows the browser again only when this
  /// page commits. Not when the failure page itself failed: that would loop, and the
  /// host stays black until the next load.
  func failed(_ error: NSError) {
    let wasShowingPage = tracker.showingFailurePage
    let outcome = tracker.navigationFailed(error)
    guard error.domain == PageLoadTracker.netErrorDomain, !wasShowingPage, let requested else {
      return apply(outcome)
    }
    if case .failed(let f) = outcome, f.failures == 1 { failingSince = Date() }
    let page = UnreachablePage.content(
      target: requested, netError: error.code, evidence: localNetworkEvidence?(failingSince ?? Date()) ?? .none)
    apply(outcome, note: page.logNote)
    tracker.failurePageShown()
    navigate(UnreachablePage.url(page))
  }

  func processEnded(_ why: String) {
    onProcessGone?(why)
    apply(tracker.processTerminated())
  }

  /// `note` ends the failure's log line: what the output shows instead.
  private func apply(_ outcome: PageLoadTracker.Outcome, note: String = "") {
    switch outcome {
    case .none:
      return
    case .failed(let f):
      // Once per run of failures, and again only when the reason changes: the
      // retries are on a fixed schedule, and the recovery is its own line.
      if f.log {
        Log.error(
          .output,
          "\(label): page did not load (\(f.reason)); retrying in \(Int(f.delay)) s, backing off to every \(Int(Backoff.reloadCap)) s\(note)")
      }
      onLoadResult?(f.failures)
      reloadWork?.cancel()
      let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.reload() } }
      reloadWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + f.delay, execute: work)
    case .loaded(let afterFailures):
      failingSince = nil
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
  var localNetworkEvidence: (@MainActor (_ since: Date) -> UnreachablePage.Evidence)?

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
