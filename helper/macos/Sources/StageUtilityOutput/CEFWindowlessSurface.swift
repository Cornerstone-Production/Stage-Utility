import AppKit
import IOSurface
import StageUtilityCEFHostAPI
import StageUtilityOutputCore

/// A card output's page: a CEF browser with no window. It draws a frame only when
/// `beginFrame()` asks, and hands each one over as an IOSurface to `onPicture`, which
/// must copy what it needs before it returns.
@MainActor
final class CEFWindowlessSurface: WebSurface {
  private let api: UnsafePointer<su_cef_api>
  private let loader: SurfaceLoader
  private let events = BrowserEvents()
  private let label: String
  private let offscreen = NSView(frame: .zero)
  /// Made in init and freed in `stop`, after the frame clock has stopped calling
  /// `beginFrame` (see CardOutput).
  private var browser: OpaquePointer?
  private var pendingSnapshots: [@MainActor (CGImage?, String?) -> Void] = []

  /// Every frame the page draws, on the main thread.
  var onPicture: ((IOSurfaceRef) -> Void)?

  var hostView: NSView { offscreen }
  private(set) var problems: [String] = []
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
    var navigate: ((URL) -> Void)?
    loader = SurfaceLoader(label: label) { url in navigate?(url) }
    events.drive(loader, label: label)
    var table = events.table
    browser = api.pointee.create_windowless!(Int32(size.width), Int32(size.height), "about:blank", &table)
    if browser == nil {
      problems = ["Chromium could not make a windowless browser for \(label)."]
      Log.error(.cef, "\(label): Chromium could not make a windowless browser")
    }
    navigate = { [weak self] url in
      guard let self, let browser = self.browser else { return }
      self.api.pointee.load!(browser, url.absoluteString)
    }
    events.painted = { [weak self] surface in self?.painted(surface) }
  }

  /// The browser, for a frame clock to call `begin_frame` on from its own queue.
  var handle: OpaquePointer? { browser }

  /// Lay the page out at a new size: a turned output lays out portrait.
  func resize(to size: CGSize) {
    guard let browser else { return }
    api.pointee.resize!(browser, Int32(size.width), Int32(size.height))
  }

  func load(_ url: URL) { loader.show(url) }
  func reload() { loader.reload() }

  func stop() {
    loader.stop()
    if let browser { api.pointee.close!(browser) }
    browser = nil
    for done in pendingSnapshots { done(nil, "the output stopped") }
    pendingSnapshots = []
  }

  /// The next frame the page draws, copied out of its IOSurface.
  func snapshot(completion: @escaping @MainActor (CGImage?, String?) -> Void) {
    guard browser != nil else {
      completion(nil, "no browser")
      return
    }
    pendingSnapshots.append(completion)
  }

  private func painted(_ surface: IOSurfaceRef) {
    if !pendingSnapshots.isEmpty {
      let waiting = pendingSnapshots
      pendingSnapshots = []
      let image = IOSurfaceImage.copy(surface)
      for done in waiting { done(image, image == nil ? "could not read the frame's IOSurface" : nil) }
    }
    onPicture?(surface)
  }
}

enum IOSurfaceImage {
  /// A CGImage of a BGRA IOSurface, copied while it is locked: the surface goes back
  /// to Chromium's pool when the paint callback returns.
  static func copy(_ surface: IOSurfaceRef) -> CGImage? {
    guard IOSurfaceLock(surface, .readOnly, nil) == kIOReturnSuccess else { return nil }
    defer { IOSurfaceUnlock(surface, .readOnly, nil) }
    let width = IOSurfaceGetWidth(surface)
    let height = IOSurfaceGetHeight(surface)
    let rowBytes = IOSurfaceGetBytesPerRow(surface)
    let data = Data(bytes: IOSurfaceGetBaseAddress(surface), count: rowBytes * height)
    guard let provider = CGDataProvider(data: data as CFData) else { return nil }
    return CGImage(
      width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: rowBytes,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
      provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
  }
}
