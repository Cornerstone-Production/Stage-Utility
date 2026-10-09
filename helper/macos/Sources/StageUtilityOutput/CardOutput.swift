import AppKit
import DeckLinkKit
import IOSurface
import StageUtilityCEFHostAPI
import StageUtilityOutputCore

/// An output that is a card port, real or virtual: a windowless page whose pictures
/// go out of a `DeckLinkOutputPort`, on the port's clock.
///
/// - The port's clock thread asks the `SurfaceFrameSource` to start each slot's
///   picture the head start before the slot goes to air: the source sends the
///   browser its begin frame (`onBeginFrame`), and CEF runs `SendExternalBeginFrame`
///   on its UI thread, so the page renders once per output frame.
/// - The page's picture arrives in `OnAcceleratedPaint` and is converted there, to
///   UYVY at the card's frame size and turned by the screen's rotation, since the
///   IOSurface is valid only inside that callback.
/// - The fill lead before air, the clock thread copies the newest converted picture
///   into the slot's frame, or has none and the port repeats the last.
/// - The page lays out at the port's frame size, turned for a quarter turn, each
///   time the port opens (`CardPageLayout`), and the source converts to the size of
///   the frames the port asks it to fill: neither can be out of step with a port
///   that opens late or reopens in another format.
///
/// The counts (new, repeated, dropped, resyncs) are the shim scheduler's, the same
/// for a DeckLink port and a virtual one; health and the falling-behind lines come
/// from them (`DeckLinkOutputPort`).
@MainActor
final class CardOutput: OutputSink {
  /// How a card output runs, from the command line: development settings, all of
  /// them off or at their measured defaults in use.
  struct Settings {
    /// When each slot's picture is asked for and filled (`--head-start`, `--fill-lead`).
    var leads = CardLeads.standard
    /// The page is the latency page (`--test-pattern latency`): read when each
    /// picture's content was drawn from its stamp, rather than estimating it.
    var readsLatencyStamp = false
    /// Every slot's timing, on the port's queue (`--frame-timings`).
    var onTimings: ((String, [FrameTiming]) -> Void)?
  }

  let descriptor: OutputDescriptor
  let surface: WebSurface
  private let port: DeckLinkOutputPort?
  private let source: SurfaceFrameSource?
  /// Why this output cannot send anything at all, for the window; nil when it can.
  private let setupProblem: String?
  private var layout: CardPageLayout
  /// The port's status as it last said (`onStatus`), on the main thread.
  private var portStatus: DeckLinkOutputPort.Status?
  /// Called on the main thread when `problem` may have changed.
  var onProblemChange: (() -> Void)?
  /// The screen's `videoMode` as last applied; nil is the default.
  private var videoMode: String?
  /// Why the last picture could not be copied, said once per cause.
  private var presentProblem: String?
  /// Keeps App Nap from slowing the clock while any card output runs: the helper
  /// is an agent app and may have no window on screen at all.
  private let activity: NSObjectProtocol
  private let readsLatencyStamp: Bool

  /// - Parameter videoMode: the format to open in, as the screen last set it (kept in
  ///   outputs.json); nil for the default.
  init(
    descriptor: OutputDescriptor, hardware: DeckLinkOutputPort.Hardware, videoMode: String? = nil,
    settings: Settings = Settings()
  ) {
    self.descriptor = descriptor
    self.videoMode = VideoModes.normalised(videoMode)
    readsLatencyStamp = settings.readsLatencyStamp
    let label = descriptor.port
    activity = ProcessInfo.processInfo.beginActivity(
      options: [.userInitiated, .latencyCritical], reason: "\(label) sends frames on a clock")
    let fallback = CGSize(width: 1920, height: 1080)
    layout = CardPageLayout(pageMadeAt: PixelSize(width: Int(fallback.width), height: Int(fallback.height)))
    guard let api = CEFEngine.api else {
      // Said once for the whole app (`CEFEngine.failure`).
      surface = DeadSurface(size: fallback)
      (port, source, setupProblem) = (nil, nil, nil)
      return
    }
    guard let converter = CardOutput.converter.value else {
      surface = DeadSurface(size: fallback)
      (port, source, setupProblem) = (nil, nil, "Cannot send frames: \(CardOutput.converter.problem ?? "no GPU")")
      return
    }
    let page = CEFWindowlessSurface(api: api, label: label, size: fallback)
    surface = page
    guard let browser = page.handle else {
      (port, source, setupProblem) = (nil, nil, nil)
      return
    }
    let source = SurfaceFrameSource(converter: converter)
    // On the port's clock thread, once per slot. The browser is closed only after
    // the port is (see `stop`), so it outlives every call.
    source.onBeginFrame = { _ in api.pointee.begin_frame!(browser) }
    let port = DeckLinkOutputPort(
      label: label, hardware: hardware, source: source, leads: settings.leads, log: Log.decklink)
    if let onTimings = settings.onTimings { port.onTimings = { onTimings(label, $0) } }
    port.onSourceStalled = { [weak page] in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          Log.error(.output, "\(label): the page has drawn no new picture for \(CardWatch.stallSeconds) s; reloading it")
          page?.reload()
        }
      }
    }
    self.source = source
    self.port = port
    setupProblem = nil
    page.onPicture = { [weak self] surface in self?.present(surface) }
    port.onOpened = { [weak self] size in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.portOpened(size) } }
    }
    port.onStatus = { [weak self] status in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self else { return }
          self.portStatus = status
          self.onProblemChange?()
        }
      }
    }
    port.open(videoMode: self.videoMode)
  }

  /// One Metal device, queue and pipeline for every card output.
  private static let converter: (value: UYVYConverter?, problem: String?) = {
    do {
      return (try UYVYConverter(), nil)
    } catch {
      Log.error(.decklink, "could not set up the GPU conversion to UYVY, so no card output can send frames: \(error)")
      return (nil, "\(error)")
    }
  }()

  func show(url: URL) { surface.load(url) }

  func stop() {
    // The port first: it calls the browser from its thread, and `surface.stop()`
    // frees the browser. No fill runs after `close` returns.
    port?.close()
    surface.stop()
    ProcessInfo.processInfo.endActivity(activity)
  }

  func takeHealthSample() -> HealthSample { port?.takeHealthSample() ?? HealthSample(fps: 0) }

  /// The source turns the frames in Metal; the page lays out at the turned size.
  func setRotation(_ new: Rotation) {
    source?.rotation = new
    if let size = layout.turned(new) { resizePage(size) }
  }

  /// The screen's `videoMode` (nil for the default, 1080p59.94): the port reopens
  /// in it, or refuses it, which the port logs and `problem` says.
  func setVideoMode(_ mode: String?) {
    let asked = VideoModes.normalised(mode)
    guard let port, VideoModes.effective(asked) != VideoModes.effective(videoMode) else { return }
    videoMode = asked
    // The page is laid out again when the port opens in it (`portOpened`), which for
    // a port that is lost is not now.
    port.open(videoMode: asked)
  }

  /// What keeps this output from sending the page, for its line in the window: a
  /// mode the port cannot play, a port that is gone, or a page that has drawn
  /// nothing. Nil while the page goes out.
  var problem: String? {
    if let setupProblem { return setupProblem }
    guard let status = portStatus else { return nil }
    switch status.state {
    case .refused(let why): return "Cannot play \(VideoModes.effective(videoMode)): \(why)"
    case .lost(let why): return "Port unavailable (\(why)). Retrying"
    case .running: return status.silence.map(StatusText.silenceLine)
    case .closed: return nil
    }
  }

  /// A device arrived: a lost port tries again now.
  func retry() { port?.retry() }

  /// The next new frame the card is sent, decoded from UYVY back to RGB: the dump
  /// shows the Metal conversion, the turn and the scaling, not the page before
  /// them. Copied as the page hands it over, on the main thread (once per dump);
  /// decoded, encoded and written off it, since the pictures arrive there.
  func writeSnapshot(to file: URL, completion: @escaping (FrameDumpOutcome) -> Void) {
    guard let source else {
      completion(.failed("no frames: the output is not running"))
      return
    }
    let done: @Sendable (FrameDumpOutcome) -> Void = { outcome in DispatchQueue.main.async { completion(outcome) } }
    source.captureNextFrame { frame in
      guard let frame else {
        done(.noNewFrame)
        return
      }
      DispatchQueue.global(qos: .utility).async {
        done(CardDump.write(frame, to: file).map(FrameDumpOutcome.failed) ?? .written)
      }
    }
  }

  /// The port opened, first or again: the page at its frame size, portrait for a
  /// quarter turn.
  private func portOpened(_ size: PixelSize) {
    if let page = layout.portOpened(size) { resizePage(page) }
  }

  private func resizePage(_ size: PixelSize) {
    (surface as? CEFWindowlessSurface)?.resize(to: CGSize(width: size.width, height: size.height))
  }

  /// The latency page's stamp has been read, and the last picture had one.
  private var readingStamps = false

  /// On the main thread, inside the paint callback.
  private func present(_ surface: IOSurfaceRef) {
    var drawn: UInt64?
    if readsLatencyStamp {
      drawn = LatencyStampReader.contentNs(surface)
      // Said on the change only: a page still loading has no stamp yet.
      if drawn != nil, !readingStamps {
        Log.notice(.output, "\(descriptor.port): reading the latency page's stamps")
      } else if drawn == nil, readingStamps {
        Log.error(.output, "\(descriptor.port): a picture had no latency stamp; it is timed from its begin frame")
      }
      readingStamps = drawn != nil
    }
    do {
      try source?.present(surface, contentNs: drawn)
      if presentProblem != nil {
        Log.notice(.output, "\(descriptor.port): its pictures can be copied again")
        presentProblem = nil
      }
    } catch {
      let why = "\(error)"
      if presentProblem != why { Log.error(.output, "\(descriptor.port): could not copy the page's picture: \(why)") }
      presentProblem = why
    }
  }
}

enum CardDump {
  /// A UYVY frame as a PNG. Nil on success, else why not.
  static func write(_ frame: CardFrameCopy, to file: URL) -> String? {
    let rgba = UYVYDecode.rgba(frame.bytes, width: frame.width, height: frame.height, rowBytes: frame.rowBytes)
    guard !rgba.isEmpty, let provider = CGDataProvider(data: Data(rgba) as CFData),
      let image = CGImage(
        width: frame.width, height: frame.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: frame.width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
      let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    else { return "could not encode the card's frame as a PNG" }
    do {
      try png.write(to: file, options: .atomic)
      return nil
    } catch {
      return "could not write \(file.path): \(error.localizedDescription)"
    }
  }
}

/// Reads the latency page's stamp (`LatencyPage.Stamp`) out of a picture the page
/// handed over: when its content was drawn, on the host clock. Only with
/// `--test-pattern latency`, where every picture carries one.
enum LatencyStampReader {
  static func contentNs(_ surface: IOSurfaceRef) -> UInt64? {
    let size = LatencyPage.Stamp.blockSize
    guard IOSurfaceGetWidth(surface) >= LatencyPage.Stamp.blocks * size, IOSurfaceGetHeight(surface) >= size,
      IOSurfaceLock(surface, .readOnly, nil) == kIOReturnSuccess
    else { return nil }
    defer { IOSurfaceUnlock(surface, .readOnly, nil) }
    let base = IOSurfaceGetBaseAddress(surface)
    let rowBytes = IOSurfaceGetBytesPerRow(surface)
    // The middle of each block; BGRA, so green is the second byte.
    let stamp = LatencyPage.Stamp.decode { i in
      base.load(fromByteOffset: (size / 2) * rowBytes + (i * size + size / 2) * 4 + 1, as: UInt8.self) > 128
    }
    guard let stamp else { return nil }
    return LatencyPage.Stamp.hostNs(
      of: stamp, epochNowMicros: UInt64(Date().timeIntervalSince1970 * 1e6),
      hostNowNs: DispatchTime.now().uptimeNanoseconds)
  }
}
