import Foundation
import IOSurface
import Metal
import StageUtilityOutputCore

/// A `CardFrameSource` that sends the latest picture an engine has handed it.
///
/// A windowless browser hands its picture over as an IOSurface that is valid only
/// inside the paint callback, so `present` converts it there, on the GPU, straight
/// to UYVY at the card's frame size and turned by the screen's rotation, into a
/// buffer of its own. When the card's slot is filled, the newest converted picture
/// is copied into the frame: a copy of a few megabytes, so the fill is quick and
/// sure, and the conversion is never on the card's deadline. If nothing new has
/// been presented since the last fill, the card repeats the previous picture.
///
/// Three buffers are kept, so a picture can be converted while the card is copying
/// another and a third is the newest: no lock is held while the GPU works.
///
/// Sendable by hand: its state is behind `lock`, which is never held while the GPU
/// works; `present` is called from one thread, and `onBeginFrame` is set before the
/// port that calls it opens.
public final class SurfaceFrameSource: CardFrameSource, @unchecked Sendable {
  private struct Staged {
    var buffer: MTLBuffer
    var picture = CardPicture.untimed
  }

  private let converter: UYVYConverter
  private let lock = NSLock()
  private var staged: [Staged] = []
  private var stagedSize: (width: Int, height: Int)?
  private var newest: Int?
  private var reading: Int?
  private var fresh = false
  private var _rotation: Rotation = .none
  private var _frameSize: (width: Int, height: Int)?
  private var _failure: String?
  private var capture: ((CardFrameCopy?) -> Void)?
  /// The begin frame asked for that no picture has answered yet, host ns.
  private var unanswered: UInt64?
  private let now: () -> UInt64

  /// Called on the output's clock thread each time a slot's picture is to be
  /// started: an engine that renders on command sends its begin frame from here.
  /// Hop to the engine's own thread to do it.
  public var onBeginFrame: ((CardFrameRequest) -> Void)?

  /// - Parameter now: the host clock in nanoseconds, the same as the card's.
  public init(converter: UYVYConverter, now: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }) {
    self.converter = converter
    self.now = now
  }

  /// The screen's `rotation`, applied from the next picture presented.
  public var rotation: Rotation {
    get { lock.withLock { _rotation } }
    set { lock.withLock { _rotation = newValue } }
  }

  /// The card's frame size, which pictures are converted to: the size of the frames
  /// the port last asked to have filled. Until a port has asked (its pre-roll, as it
  /// opens), pictures presented are dropped.
  ///
  /// Learnt from the fills, never set by an owner, so it cannot fall out of step with
  /// the port: a port that opens only on a retry, or reopens in another format after
  /// being lost, has its pictures converted at its own size from its first fill.
  public var frameSize: (width: Int, height: Int)? { lock.withLock { _frameSize } }

  /// Why the last picture could not be converted, nil once one has been. The card
  /// repeats the previous picture meanwhile, so it shows in the repeat count.
  public var failure: String? { lock.withLock { _failure } }

  /// The next new picture exactly as the card is sent it (converted, turned,
  /// scaled), handed to `done` on the thread that presented it, as soon as it is
  /// converted: what `--dump-frames` writes. Taken there, not at the fill, because a
  /// 4 MB copy on the clock thread made a frame late. A capture still waiting when
  /// another is asked for gets nil, so a page that has stopped drawing does not pile
  /// them up.
  public func captureNextFrame(_ done: @escaping (CardFrameCopy?) -> Void) {
    let replaced: ((CardFrameCopy?) -> Void)? = lock.withLock {
      let old = capture
      capture = done
      return old
    }
    replaced?(nil)
  }

  /// A begin frame with no picture this long after it is taken as never answered.
  public static let answerWithinNs: UInt64 = 100_000_000

  /// A picture is timed from the begin frame it answers, which for a picture slower
  /// than a frame is not the last one asked for. CEF sends no begin frame while one
  /// it sent is still being drawn (`SendExternalBeginFrame` returns at once while its
  /// begin frame is pending), so a begin asked for while an earlier one is unanswered
  /// makes no picture of its own, and the next picture answers the earlier one. It
  /// is not kept: kept, every picture after a slow one would be timed a frame early.
  public func begin(_ request: CardFrameRequest) {
    let at = now()
    lock.withLock {
      if let pending = unanswered, at >= pending, at - pending < Self.answerWithinNs { return }
      unanswered = at
    }
    onBeginFrame?(request)
  }

  /// A new picture: a 32-bit BGRA IOSurface, upright, at the size the page laid out
  /// at. Converted before this returns. Call it from one thread.
  ///
  /// - Parameter contentNs: when the picture's content was drawn, if the caller
  ///   knows (the latency page says, in its stamp). Otherwise it is the begin frame
  ///   this picture answers (`begin`), or 0, unknown, for a picture that answers none.
  public func present(_ surface: IOSurfaceRef, contentNs: UInt64? = nil) throws {
    guard let texture = converter.texture(for: surface) else {
      throw UYVYConverter.Failure.gpu("could not read the surface as BGRA")
    }
    try present(texture, contentNs: contentNs)
  }

  public func present(_ texture: MTLTexture, contentNs: UInt64? = nil) throws {
    let paintNs = now()
    typealias Chosen = (slot: Int, buffer: MTLBuffer, rotation: Rotation, size: (width: Int, height: Int), content: UInt64)
    let chosen: Chosen? = try lock.withLock {
      // Answered, whether or not the picture can be used. A begin asked for after
      // the picture was handed over is not what it answers.
      var answered: UInt64 = 0
      if let pending = unanswered, pending <= paintNs {
        answered = pending
        unanswered = nil
      }
      guard let size = _frameSize else { return nil }
      if stagedSize.map({ $0.width != size.width || $0.height != size.height }) ?? true {
        guard reading == nil else { throw UYVYConverter.Failure.gpu("the frame changed size mid-frame") }
        staged = try (0..<3).map { _ in
          Staged(buffer: try converter.makeFrameBuffer(rowBytes: size.width * 2, height: size.height))
        }
        stagedSize = size
        newest = nil
        fresh = false
      }
      let slot = (0..<3).first { $0 != newest && $0 != reading }!
      let content = contentNs ?? answered
      return (slot, staged[slot].buffer, _rotation, size, content)
    }
    guard let chosen else { return }
    do {
      try converter.convert(
        texture, rotation: chosen.rotation, into: chosen.buffer, width: chosen.size.width,
        height: chosen.size.height, rowBytes: chosen.size.width * 2)
    } catch {
      lock.withLock { _failure = "\(error)" }
      throw error
    }
    let readyNs = now()
    let done: ((CardFrameCopy?) -> Void)? = lock.withLock {
      // A size change while this one converted has replaced the buffers.
      guard staged.indices.contains(chosen.slot), staged[chosen.slot].buffer === chosen.buffer else { return nil }
      staged[chosen.slot].picture = CardPicture(contentNs: chosen.content, paintNs: paintNs, readyNs: readyNs)
      newest = chosen.slot
      fresh = true
      _failure = nil
      defer { capture = nil }
      return capture
    }
    if let done {
      let row = chosen.size.width * 2
      done(
        CardFrameCopy(
          bytes: Array(UnsafeRawBufferPointer(start: chosen.buffer.contents(), count: row * chosen.size.height)),
          width: chosen.size.width, height: chosen.size.height, rowBytes: row))
    }
  }

  public func fill(_ request: CardFrameRequest, into target: CardFrameTarget) -> CardPicture? {
    let taken: (buffer: MTLBuffer, picture: CardPicture)? = lock.withLock {
      if _frameSize.map({ $0.width != target.width || $0.height != target.height }) ?? true {
        _frameSize = (target.width, target.height)
      }
      guard fresh, let newest, let size = stagedSize, size.width == target.width, size.height == target.height,
        target.rowBytes >= size.width * 2
      else { return nil }
      fresh = false
      reading = newest
      return (staged[newest].buffer, staged[newest].picture)
    }
    guard let taken else { return nil }
    defer { lock.withLock { reading = nil } }
    let row = target.width * 2
    let from = taken.buffer.contents()
    if target.rowBytes == row {
      target.bytes.copyMemory(from: from, byteCount: row * target.height)
    } else {
      for y in 0..<target.height {
        (target.bytes + y * target.rowBytes).copyMemory(from: from + y * row, byteCount: row)
      }
    }
    return taken.picture
  }
}

/// A frame as the card was sent it: 8-bit UYVY, `rowBytes` per line.
public struct CardFrameCopy: Sendable {
  public var bytes: [UInt8]
  public var width: Int
  public var height: Int
  public var rowBytes: Int

  init(bytes: [UInt8], width: Int, height: Int, rowBytes: Int) {
    self.bytes = bytes
    self.width = width
    self.height = height
    self.rowBytes = rowBytes
  }
}
