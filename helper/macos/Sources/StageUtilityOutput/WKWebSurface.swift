import AppKit
import StageUtilityOutputCore
import WebKit

/// The surface for an output today: a `WKWebView`, with the WebKit switches that keep
/// it painting when its window is covered, locked or asleep. The one place in the
/// helper that names WebKit; everything else sees a `WebSurface`.
@MainActor
final class WKWebSurface: NSObject, WebSurface, WKNavigationDelegate {
  private let webView: WKWebView
  private let loader: SurfaceLoader
  private let label: String
  let problems: [String]

  var hostView: NSView { webView }
  var onLoadResult: (@MainActor (_ failures: Int) -> Void)? {
    get { loader.onLoadResult }
    set { loader.onLoadResult = newValue }
  }
  var onCommitted: (@MainActor (URL) -> Void)? {
    get { loader.onCommitted }
    set { loader.onCommitted = newValue }
  }

  init(label: String, size: CGSize) {
    self.label = label
    let config = WKWebViewConfiguration()
    var missing = KeepPainting.apply(to: config.preferences)
    let view = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
    missing += KeepPainting.apply(to: view)
    webView = view
    problems =
      missing.isEmpty
      ? []
      : ["WebKit switches missing or not taking, so this output may freeze when the screen locks or the display sleeps: \(missing.joined(separator: ", "))"]
    loader = SurfaceLoader(label: label) { [weak view] url in
      view?.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
    }
    super.init()
    webView.navigationDelegate = self
    webView.autoresizingMask = [.width, .height]
    // Black while a page loads or the server is away, not white.
    webView.underPageBackgroundColor = .black
  }

  func load(_ url: URL) { loader.show(url) }
  func reload() { loader.reload() }

  func stop() {
    loader.stop()
    webView.stopLoading()
    webView.navigationDelegate = nil
  }

  func snapshot(completion: @escaping @MainActor (CGImage?, String?) -> Void) {
    let config = WKSnapshotConfiguration()
    config.afterScreenUpdates = false
    config.snapshotWidth = NSNumber(value: Double(webView.bounds.width))
    webView.takeSnapshot(with: config) { image, error in
      MainActor.assumeIsolated {
        guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
          completion(nil, "no snapshot: \(error?.localizedDescription ?? "web view returned nothing")")
          return
        }
        completion(cg, nil)
      }
    }
  }

  // MARK: WKNavigationDelegate

  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
    if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse {
      loader.responded(status: http.statusCode)
    }
    return .allow
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    // webView.url here is the COMMITTED address; while a load is in flight it reports
    // the one being loaded, which is not what is on the screen.
    if let url = webView.url { loader.committed(url) }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loader.finished() }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    loader.failed(error as NSError)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    loader.failed(error as NSError)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    Log.error(.webkit, "\(label): the web content process ended; reloading")
    loader.processEnded()
  }
}

enum WebSurfaces {
  /// The surface an output uses. The only place that picks an engine.
  @MainActor
  static func make(label: String, size: CGSize) -> WebSurface { WKWebSurface(label: label, size: size) }
}
