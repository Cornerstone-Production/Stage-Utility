import AppKit
import IOSurface
import StageUtilityCEFHostAPI
import StageUtilityOutputCore

/// A card output's page: a CEF browser with no window. It draws a frame only when
/// `beginFrame()` asks, and hands each one over as an IOSurface to `onPicture`, which
/// must copy what it needs before it returns.
@MainActor
final class CEFWindowlessSurface: CEFPage, WebSurface {
  private let offscreen = NSView(frame: .zero)

  /// Every frame the page draws, on the main thread.
  var onPicture: ((IOSurfaceRef) -> Void)?

  var hostView: NSView { offscreen }
  private(set) var problems: [String] = []

  /// The browser is made at once, on about:blank, and freed in `stop`, after the
  /// frame clock has stopped calling `begin_frame` (see CardOutput).
  init(api: UnsafePointer<su_cef_api>, label: String, size: CGSize) {
    super.init(api: api, label: label)
    var table = events.table
    browser = api.pointee.create_windowless!(Int32(size.width), Int32(size.height), "about:blank", &table)
    if browser == nil {
      problems = ["Chromium could not make a windowless browser for \(label)."]
      Log.error(.cef, "\(label): Chromium could not make a windowless browser")
    }
    events.painted = { [weak self] surface in self?.onPicture?(surface) }
  }

  /// The browser, for a frame clock to call `begin_frame` on from its own queue.
  var handle: OpaquePointer? { browser }

  /// Lay the page out at a new size: a turned output lays out portrait.
  func resize(to size: CGSize) {
    guard let browser else { return }
    api.pointee.resize!(browser, Int32(size.width), Int32(size.height))
  }

  /// Not the way to see a card output: its dump is the frame the card is sent,
  /// after the conversion and the turn (`CardOutput.writeSnapshot`).
  func snapshot(completion: @escaping @MainActor (CGImage?, String?) -> Void) {
    completion(nil, "a card output's picture is its frame: see CardOutput.writeSnapshot")
  }
}
