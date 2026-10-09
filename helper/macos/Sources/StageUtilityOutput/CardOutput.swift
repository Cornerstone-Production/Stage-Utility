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
/// - The page lays out at the port's frame size, turned for a quarter turn.
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
  private var rotation: Rotation = .none
  /// The screen's `videoMode` as last applied; nil is the default.
  private var videoMode: String?
  /// Why the last picture could not be copied, said once per cause.
  private var presentProblem: String?
  /// Keeps App Nap from slowing the clock while any card output runs: the helper
  /// is an agent app and may have no window on screen at all.
  private let activity: NSObjectProtocol
  private let readsLatencyStamp: Bool

  init(descriptor: OutputDescriptor, hardware: DeckLinkOutputPort.Hardware, settings: Settings = Settings()) {
    self.descriptor = descriptor
    readsLatencyStamp = settings.readsLatencyStamp
    let label = descriptor.port
    activity = ProcessInfo.processInfo.beginActivity(
      options: [.userInitiated, .latencyCritical], reason: "\(label) sends frames on a clock")
    let fallback = CGSize(width: 1920, height: 1080)
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
    port.open(videoMode: nil)
    layOut()
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
    rotation = new
    source?.rotation = new
    layOut()
  }

  /// The screen's `videoMode` (nil for the default, 1080p59.94): the port reopens
  /// in it, or refuses it, which the port logs and `problem` says.
  func setVideoMode(_ mode: String?) {
    let asked = mode?.trimmingCharacters(in: .whitespaces).isEmpty == false ? mode : nil
    guard let port, (asked ?? VideoModes.defaultMode) != (videoMode ?? VideoModes.defaultMode) else { return }
    videoMode = asked
    port.open(videoMode: asked)
    layOut()
  }

  /// What keeps this output from sending, for its line in the window: a mode the
  /// port cannot play, or a port that is gone. Nil while it runs.
  var problem: String? {
    if let setupProblem { return setupProblem }
    switch port?.state {
    case .refused(let why): return "Cannot play \(videoMode ?? VideoModes.defaultMode): \(why)"
    case .lost(let why): return "Port unavailable (\(why)). Retrying"
    case .running, .closed, nil: return nil
    }
  }

  /// A device arrived: a lost port tries again now.
  func retry() { port?.retry() }

  /// The next new frame the card is sent, decoded from UYVY back to RGB: the dump
  /// shows the Metal conversion, the turn and the scaling, not the page before
  /// them. Copied on the port's thread; decoded, encoded and written off the main
  /// thread, which the port's frames depend on.
  func writeSnapshot(to file: URL, completion: @escaping (String?) -> Void) {
    guard let source else {
      completion("no frames: the output is not running")
      return
    }
    let done: @Sendable (String?) -> Void = { why in DispatchQueue.main.async { completion(why) } }
    source.captureNextFrame { frame in
      guard let frame else {
        done("no new frame since the last dump")
        return
      }
      DispatchQueue.global(qos: .utility).async { done(CardDump.write(frame, to: file)) }
    }
  }

  /// The page at the port's frame size, portrait for a quarter turn; its pictures
  /// converted to the frame size.
  private func layOut() {
    guard let page = surface as? CEFWindowlessSurface, let size = port?.frameSize else { return }
    source?.frameSize = size
    let w = CGFloat(size.width)
    let h = CGFloat(size.height)
    page.resize(to: rotation.swapsAxes ? CGSize(width: h, height: w) : CGSize(width: w, height: h))
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
