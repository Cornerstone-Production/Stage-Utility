import AppKit
import QuartzCore
import StageUtilityOutputCore
import WebKit

/// An output that is a display: a borderless window covering one NSScreen, holding
/// a web view of the screen's URL.
final class DisplaySink: NSObject, OutputSink, WKNavigationDelegate {
  let descriptor: OutputDescriptor

  /// How a load ended. `failures` is the run of consecutive failures (0 on success).
  var onLoadResult: ((_ failures: Int, _ reason: String?) -> Void)?
  /// A page load failed in a way that fits a refused Local Network permission.
  var onLocalNetworkSuspected: (() -> Void)?
  /// The page navigated, including the server's redirect from /enroll to the screen.
  var onURLChange: ((URL?) -> Void)?
  /// The WebKit switches that were missing or did not take, set once at creation.
  let keepPaintingProblems: [String]

  private var window: NSWindow?
  private let webView: WKWebView
  private var requested: URL?
  private var failures = 0
  private var responseFailed = false
  private var reloadWork: DispatchWorkItem?
  private var urlObservation: NSKeyValueObservation?

  private var link: CADisplayLink?
  private var ticks = 0
  private var sampleStart = CACurrentMediaTime()

  init(descriptor: OutputDescriptor, screen: NSScreen) {
    self.descriptor = descriptor
    let config = WKWebViewConfiguration()
    var problems = KeepPainting.apply(to: config.preferences)
    webView = WKWebView(frame: NSRect(origin: .zero, size: screen.frame.size), configuration: config)
    problems += KeepPainting.apply(to: webView)
    keepPaintingProblems = problems
    super.init()
    webView.navigationDelegate = self
    webView.autoresizingMask = [.width, .height]
    // Black while a page loads or the server is away, not white.
    webView.underPageBackgroundColor = .black
    urlObservation = webView.observe(\.url, options: [.new]) { [weak self] view, _ in
      self?.onURLChange?(view.url)
    }

    let win = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false, screen: screen)
    win.isReleasedWhenClosed = false
    win.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 1)
    win.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    win.backgroundColor = .black
    win.hasShadow = false
    win.hidesOnDeactivate = false
    win.contentView = webView
    win.setFrame(screen.frame, display: true)
    win.orderFrontRegardless()
    window = win
    startLink(on: screen)
  }

  // MARK: OutputSink

  func show(url: URL) {
    if requested == url, window != nil { return }
    requested = url
    failures = 0
    responseFailed = false
    load()
  }

  func stop() {
    reloadWork?.cancel()
    reloadWork = nil
    link?.invalidate()
    link = nil
    urlObservation = nil
    webView.stopLoading()
    webView.navigationDelegate = nil
    window?.orderOut(nil)
    window?.close()
    window = nil
    requested = nil
  }

  /// A hot-plug or a resolution change moved the display: follow it.
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

  // MARK: Loading

  private func load() {
    guard let requested else { return }
    reloadWork?.cancel()
    webView.load(URLRequest(url: requested, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
  }

  private func failed(_ reason: String, suspectedDenial: Bool = false) {
    failures += 1
    if suspectedDenial {
      Log.error(.output, "\(descriptor.port): the load failed with no route to host, which is what Local Network access being off looks like")
      onLocalNetworkSuspected?()
    }
    let delay = Backoff.reloadDelay(failures: failures)
    Log.error(.output, "\(descriptor.port): page did not load (\(reason)); reload \(failures) in \(Int(delay)) s")
    onLoadResult?(failures, reason)
    reloadWork?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.load() }
    reloadWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  // MARK: WKNavigationDelegate

  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
    if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse, http.statusCode >= 500 {
      responseFailed = true
      failed("server answered \(http.statusCode)")
    }
    return .allow
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if responseFailed {
      responseFailed = false
      return
    }
    if failures > 0 { Log.notice(.output, "\(descriptor.port): page loaded again after \(failures) failures") }
    failures = 0
    onLoadResult?(0, nil)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    loadFailed(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    loadFailed(error)
  }

  private func loadFailed(_ error: Error) {
    let ns = error as NSError
    // Our own load() interrupting one in flight.
    if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled { return }
    failed(ns.localizedDescription, suspectedDenial: LocalNetworkAccess.looksLikeDenial(ns))
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    Log.error(.webkit, "\(descriptor.port): the web content process ended; reloading")
    failed("web content process ended")
  }
}
