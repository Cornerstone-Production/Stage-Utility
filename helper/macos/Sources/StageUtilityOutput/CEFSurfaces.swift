import AppKit
import IOSurface
import StageUtilityCEFHostAPI
import StageUtilityOutputCore

/// A browser's callbacks, from the host's C table to Swift. The host holds this
/// object's address unretained, so whoever made it keeps it until the browser is
/// closed; the host calls nothing after `close`.
@MainActor
final class BrowserEvents {
  var committed: ((String, Int) -> Void)?
  var finished: ((Int) -> Void)?
  var failed: ((Int, String, String) -> Void)?
  var processGone: ((Int, Int, String) -> Void)?
  var painted: ((IOSurfaceRef) -> Void)?

  private static func of(_ context: UnsafeMutableRawPointer?) -> BrowserEvents {
    Unmanaged<BrowserEvents>.fromOpaque(context!).takeUnretainedValue()
  }

  /// The table for the host, pointing back at this object.
  var table: su_browser_events {
    su_browser_events(
      context: Unmanaged.passUnretained(self).toOpaque(),
      committed: { ctx, url, status in
        MainActor.assumeIsolated { BrowserEvents.of(ctx).committed?(String(cString: url!), Int(status)) }
      },
      finished: { ctx, status in MainActor.assumeIsolated { BrowserEvents.of(ctx).finished?(Int(status)) } },
      failed: { ctx, code, text, url in
        MainActor.assumeIsolated {
          BrowserEvents.of(ctx).failed?(Int(code), String(cString: text!), String(cString: url!))
        }
      },
      process_gone: { ctx, status, code, text in
        MainActor.assumeIsolated {
          BrowserEvents.of(ctx).processGone?(Int(status), Int(code), String(cString: text!))
        }
      },
      painted: { ctx, surface in
        MainActor.assumeIsolated {
          let s = Unmanaged<IOSurfaceRef>.fromOpaque(surface!).takeUnretainedValue()
          BrowserEvents.of(ctx).painted?(s)
        }
      })
  }

  /// Route a browser's navigation events to a loader, which every engine shares.
  func drive(_ loader: SurfaceLoader, label: String) {
    committed = { url, status in
      loader.responded(status: status)
      if let u = URL(string: url) { loader.committed(u) }
    }
    finished = { _ in loader.finished() }
    failed = { code, text, url in
      loader.failed(PageLoadTracker.navigationError(code: code, text: text, url: url))
    }
    processGone = { status, code, text in
      let why = CEFTermination.describe(status: status, code: code, text: text)
      Log.error(.cef, "\(label): the page's renderer process ended (\(why)); reloading")
      loader.processEnded(why)
    }
  }
}

enum CEFTermination {
  /// `cef_termination_status_t`, in that order.
  static func describe(status: Int, code: Int, text: String) -> String {
    let names = ["exited abnormally", "was killed", "crashed", "ran out of memory", "failed to launch", "failed an integrity check"]
    let name = names.indices.contains(status) ? names[status] : "ended (status \(status))"
    // Chromium often gives the code again as the text.
    return text.isEmpty || text == String(code) ? "\(name), code \(code)" : "\(name), code \(code): \(text)"
  }
}

/// A display output's page: a CEF browser drawing in a view, inside the output's
/// window. Chromium takes clicks, touches, scrolling and typing itself, so a display
/// output can be a control surface.
///
/// The browser is made on the first load, when the view is already in its window:
/// a windowed CEF browser is a child of a view that has one.
@MainActor
final class CEFWindowedSurface: WebSurface {
  private let api: UnsafePointer<su_cef_api>
  private let container: NSView
  private let loader: SurfaceLoader
  private let events = BrowserEvents()
  private let label: String
  private var browser: OpaquePointer?

  var hostView: NSView { container }
  var problems: [String] { [] }
  var onLoadResult: (@MainActor (Int) -> Void)? {
    get { loader.onLoadResult }
    set { loader.onLoadResult = newValue }
  }
  var onCommitted: (@MainActor (URL) -> Void)? {
    get { loader.onCommitted }
    set { loader.onCommitted = newValue }
  }
  var onProcessGone: (@MainActor (String) -> Void)? {
    get { loader.onProcessGone }
    set { loader.onProcessGone = newValue }
  }

  init(api: UnsafePointer<su_cef_api>, label: String, size: CGSize) {
    self.api = api
    self.label = label
    container = NSView(frame: NSRect(origin: .zero, size: size))
    container.wantsLayer = true
    // Black while a page loads or the server is away, not white.
    container.layer?.backgroundColor = NSColor.black.cgColor
    container.autoresizingMask = [.width, .height]
    var navigate: ((URL) -> Void)?
    loader = SurfaceLoader(label: label) { url in navigate?(url) }
    events.drive(loader, label: label)
    navigate = { [weak self] url in self?.navigate(url) }
  }

  private func navigate(_ url: URL) {
    if let browser {
      api.pointee.load!(browser, url.absoluteString)
      return
    }
    var table = events.table
    browser = api.pointee.create_windowed!(Unmanaged.passUnretained(container).toOpaque(), url.absoluteString, &table)
    guard browser != nil else {
      Log.error(.cef, "\(label): Chromium could not make a browser in the window")
      return
    }
    // Chromium's view fills the container and follows it, so a turn of the
    // container (see TurnedSurfaceView) turns the page with it.
    for view in container.subviews {
      view.frame = container.bounds
      view.autoresizingMask = [.width, .height]
    }
  }

  func load(_ url: URL) { loader.show(url) }
  func reload() { loader.reload() }

  func stop() {
    loader.stop()
    if let browser { api.pointee.close!(browser) }
    browser = nil
  }

  /// Through DevTools (Page.captureScreenshot), which draws the page as the
  /// renderer does: upright, at the size it laid out at. It needs no Screen
  /// Recording permission and works on a locked screen.
  func snapshot(completion: @escaping @MainActor (CGImage?, String?) -> Void) {
    guard let browser else {
      completion(nil, "no page has been loaded yet")
      return
    }
    let box = Unmanaged.passRetained(CaptureBox(completion)).toOpaque()
    api.pointee.devtools!(browser, "Page.captureScreenshot", #"{"format":"png"}"#, box) { ctx, json, length, error in
      let box = Unmanaged<CaptureBox>.fromOpaque(ctx!).takeRetainedValue()
      let data = json.map { Data(bytes: $0, count: length) }
      let why = error.map { String(cString: $0) }
      box.finish(data: data, error: why)
    }
  }
}

/// One DevTools screenshot in flight. The answer is a few megabytes of base64 PNG;
/// it is decoded off the main thread, where card outputs get their frames.
private final class CaptureBox: @unchecked Sendable {
  let completion: @MainActor (CGImage?, String?) -> Void
  init(_ completion: @escaping @MainActor (CGImage?, String?) -> Void) { self.completion = completion }

  func finish(data: Data?, error: String?) {
    DispatchQueue.global(qos: .utility).async {
      let (image, why) = CaptureBox.decode(data: data, error: error)
      DispatchQueue.main.async { MainActor.assumeIsolated { self.completion(image, why) } }
    }
  }

  private static func decode(data: Data?, error: String?) -> (CGImage?, String?) {
    guard let data else { return (nil, "no snapshot: \(error ?? "DevTools returned nothing")") }
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let base64 = object["data"] as? String, let png = Data(base64Encoded: base64),
      let source = CGImageSourceCreateWithData(png as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { return (nil, "no snapshot: DevTools did not return a PNG") }
    return (image, nil)
  }
}
