import AppKit
import StageUtilityOutputCore
import WebKit

/// The part of an output that does not care where its pictures go: a web view that
/// loads one URL, keeps trying when the server is away, and reports what committed.
///
/// A display puts the view in a window. A DeckLink port will keep it off every
/// display and read its frames for a card. Both want the same loading, the same
/// backoff and the same WebKit switches, so those live here and the destination
/// is a separate thing (`OutputDestination`).
@MainActor
final class WebSurface: NSObject, WKNavigationDelegate {
  let webView: WKWebView
  /// The WebKit switches that were missing or did not take, set once at creation.
  let keepPaintingProblems: [String]

  /// How a load ended. `failures` is the run of consecutive failures (0 on success).
  var onLoadResult: (@MainActor (_ failures: Int) -> Void)?
  /// A page committed: the URL the web view is now showing, after the server's
  /// redirect from /enroll to the screen. Never called for a 5xx page, and never
  /// for a load that is still in flight or failed: the web view's `url` reports
  /// the address being loaded while it loads, which is not what is on the screen.
  var onCommitted: (@MainActor (URL) -> Void)?

  private let label: String
  private var tracker = PageLoadTracker()
  private var requested: URL?
  private var reloadWork: DispatchWorkItem?

  init(label: String, size: CGSize) {
    self.label = label
    let config = WKWebViewConfiguration()
    var problems = KeepPainting.apply(to: config.preferences)
    webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
    problems += KeepPainting.apply(to: webView)
    keepPaintingProblems = problems
    super.init()
    webView.navigationDelegate = self
    webView.autoresizingMask = [.width, .height]
    // Black while a page loads or the server is away, not white.
    webView.underPageBackgroundColor = .black
  }

  func show(url: URL) {
    if requested == url { return }
    requested = url
    tracker.reset()
    load()
  }

  func stop() {
    reloadWork?.cancel()
    reloadWork = nil
    webView.stopLoading()
    webView.navigationDelegate = nil
    requested = nil
  }

  /// Write what the web view is showing to `file` as a PNG. `completion` gets nil on
  /// success, else why not.
  func writeSnapshot(to file: URL, completion: @escaping (String?) -> Void) {
    let config = WKSnapshotConfiguration()
    config.afterScreenUpdates = false
    config.snapshotWidth = NSNumber(value: Double(webView.bounds.width))
    webView.takeSnapshot(with: config) { image, error in
      guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
        let png = rep.representation(using: .png, properties: [:])
      else {
        completion("no snapshot: \(error?.localizedDescription ?? "web view returned nothing")")
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

  // MARK: Loading

  private func load() {
    guard let requested else { return }
    reloadWork?.cancel()
    tracker.loadStarted()
    webView.load(URLRequest(url: requested, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
  }

  private func apply(_ outcome: PageLoadTracker.Outcome) {
    switch outcome {
    case .none:
      return
    case .failed(let f):
      Log.error(.output, "\(label): page did not load (\(f.reason)); reload \(f.failures) in \(Int(f.delay)) s")
      onLoadResult?(f.failures)
      reloadWork?.cancel()
      let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.load() } }
      reloadWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + f.delay, execute: work)
    case .loaded(let afterFailures):
      if afterFailures > 0 { Log.notice(.output, "\(label): page loaded again after \(afterFailures) failures") }
      onLoadResult?(0)
    }
  }

  // MARK: WKNavigationDelegate

  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
    if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse {
      apply(tracker.responded(status: http.statusCode))
    }
    return .allow
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    // The committed URL: what is on the screen, after any redirect. A 5xx page is
    // on the screen too, but its URL says nothing about whether the output is set up.
    guard !tracker.responseFailed, let url = webView.url else { return }
    onCommitted?(url)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    apply(tracker.finished())
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    apply(tracker.navigationFailed(error as NSError))
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    apply(tracker.navigationFailed(error as NSError))
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    Log.error(.webkit, "\(label): the web content process ended; reloading")
    apply(tracker.processTerminated())
  }
}
