import AppKit
import DeckLinkKit
import IOSurface
import StageUtilityCEFHostAPI
import StageUtilityOutputCore

/// An output that is a card port, real or virtual: a windowless page whose pictures
/// go out of a `DeckLinkOutputPort`, on the port's clock.
///
/// - The port's thread asks the `SurfaceFrameSource` for each frame. The source
///   converts the newest picture to UYVY, turned by the screen's rotation, into the
///   frame's memory, or has none and the port repeats the last.
/// - Each time it takes a frame, the source sends the browser its begin frame
///   (`onFrameTaken`); CEF runs `SendExternalBeginFrame` on its UI thread, so the
///   page renders once per output frame, ahead of the frame that will carry it.
/// - The page's picture arrives in `OnAcceleratedPaint` and is copied into the
///   source there, since the IOSurface is valid only inside that callback.
/// - The page lays out at the port's frame size, turned for a quarter turn.
///
/// The counts (new, repeated, dropped, resyncs) are the shim scheduler's, the same
/// for a DeckLink port and a virtual one; health and the falling-behind lines come
/// from them (`DeckLinkOutputPort`).
@MainActor
final class CardOutput: OutputSink {
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

  init(descriptor: OutputDescriptor, hardware: DeckLinkOutputPort.Hardware) {
    self.descriptor = descriptor
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
    // On the port's thread, once per frame it takes. The browser is closed only
    // after the port is (see `stop`), so it outlives every call.
    source.onFrameTaken = { _ in api.pointee.begin_frame!(browser) }
    let port = DeckLinkOutputPort(label: label, hardware: hardware, source: source, log: Log.decklink)
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

  /// The page at the port's frame size, portrait for a quarter turn.
  private func layOut() {
    guard let page = surface as? CEFWindowlessSurface, let size = port?.frameSize else { return }
    let w = CGFloat(size.width)
    let h = CGFloat(size.height)
    page.resize(to: rotation.swapsAxes ? CGSize(width: h, height: w) : CGSize(width: w, height: h))
  }

  /// On the main thread, inside the paint callback.
  private func present(_ surface: IOSurfaceRef) {
    do {
      try source?.present(surface)
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
