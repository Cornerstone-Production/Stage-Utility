import Foundation
import IOSurface
import Metal
import StageUtilityOutputCore

/// A `CardFrameSource` that sends the latest picture an engine has handed it.
///
/// A windowless browser hands its picture over as an IOSurface that is valid only
/// inside the paint callback, so `present` copies it on the GPU before returning.
/// When the card asks for a frame, the newest copy is converted to UYVY and turned
/// straight into the frame's memory; if nothing new has been presented since the
/// last frame, the card repeats the previous picture.
///
/// Three copies are kept, so a picture can be presented while the card is
/// converting another and a third is the newest: no lock is held while the GPU
/// works.
public final class SurfaceFrameSource: CardFrameSource {
  private let converter: UYVYConverter
  private let lock = NSLock()
  private var textures: [MTLTexture] = []
  private var newest: Int?
  private var reading: Int?
  private var fresh = false
  private var _rotation: Rotation = .none
  private var _failure: String?
  private var capture: ((CardFrameCopy?) -> Void)?

  /// Called on the card's thread each time it takes a frame, with that frame's
  /// request. An engine that renders on command sends its next begin frame from
  /// here; hop to the engine's own thread to do it.
  public var onFrameTaken: ((CardFrameRequest) -> Void)?

  public init(converter: UYVYConverter) {
    self.converter = converter
  }

  /// The screen's `rotation`, applied from the next frame.
  public var rotation: Rotation {
    get { lock.withLock { _rotation } }
    set { lock.withLock { _rotation = newValue } }
  }

  /// Why the last frame could not be converted, nil once one has been. The card
  /// repeats the previous picture meanwhile, so it shows in the repeat count.
  public var failure: String? { lock.withLock { _failure } }

  /// The next new frame exactly as the card is sent it (converted, turned, scaled),
  /// handed to `done` on the card's thread: what `--dump-frames` writes. A capture
  /// still waiting when another is asked for gets nil, so a page that has stopped
  /// drawing does not pile them up.
  public func captureNextFrame(_ done: @escaping (CardFrameCopy?) -> Void) {
    let replaced: ((CardFrameCopy?) -> Void)? = lock.withLock {
      let old = capture
      capture = done
      return old
    }
    replaced?(nil)
  }

  /// A new picture: a 32-bit BGRA IOSurface, upright, at the size the page laid out
  /// at. Copied before this returns. Call it from one thread.
  public func present(_ surface: IOSurfaceRef) throws {
    guard let texture = converter.texture(for: surface) else {
      throw UYVYConverter.Failure.gpu("could not read the surface as BGRA")
    }
    try present(texture)
  }

  public func present(_ texture: MTLTexture) throws {
    let slot: Int = try lock.withLock {
      if textures.first.map({ $0.width != texture.width || $0.height != texture.height }) ?? true {
        guard reading == nil else { throw UYVYConverter.Failure.gpu("the picture changed size mid-frame") }
        textures = try (0..<3).map { _ in try makeCopyTexture(like: texture) }
        newest = nil
        fresh = false
      }
      return (0..<3).first { $0 != newest && $0 != reading }!
    }
    try converter.copy(texture, into: textures[slot])
    lock.withLock {
      newest = slot
      fresh = true
    }
  }

  public func fill(_ request: CardFrameRequest, into target: CardFrameTarget) -> Bool {
    defer { onFrameTaken?(request) }
    let taken: (texture: MTLTexture, rotation: Rotation)? = lock.withLock {
      guard fresh, let newest else { return nil }
      fresh = false
      reading = newest
      return (textures[newest], _rotation)
    }
    guard let taken else { return false }
    defer { lock.withLock { reading = nil } }
    do {
      try converter.convert(taken.texture, rotation: taken.rotation, into: target)
      let done: ((CardFrameCopy?) -> Void)? = lock.withLock {
        _failure = nil
        defer { capture = nil }
        return capture
      }
      done?(CardFrameCopy(target))
      return true
    } catch {
      // Nothing was written that can be trusted: the card repeats the previous
      // picture and counts it, and the owner reads why from `failure`.
      lock.withLock { _failure = "\(error)" }
      return false
    }
  }

  private func makeCopyTexture(like texture: MTLTexture) throws -> MTLTexture {
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .bgra8Unorm, width: texture.width, height: texture.height, mipmapped: false)
    descriptor.usage = [.shaderRead]
    descriptor.storageMode = .private
    guard let copy = converter.device.makeTexture(descriptor: descriptor) else {
      throw UYVYConverter.Failure.gpu("could not make a texture for the picture")
    }
    return copy
  }
}

/// A frame as the card was sent it: 8-bit UYVY, `rowBytes` per line.
public struct CardFrameCopy: Sendable {
  public var bytes: [UInt8]
  public var width: Int
  public var height: Int
  public var rowBytes: Int

  init(_ target: CardFrameTarget) {
    bytes = Array(UnsafeRawBufferPointer(start: target.bytes, count: target.rowBytes * target.height))
    width = target.width
    height = target.height
    rowBytes = target.rowBytes
  }
}
