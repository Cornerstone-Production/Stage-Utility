import Foundation
import IOSurface
import Metal
import StageUtilityOutputCore

/// Turns a BGRA picture into the 8-bit UYVY 4:2:2 a DeckLink port takes, on the
/// GPU: Rec. 709, video range (Y 16-235, Cb and Cr 16-240), turned 0, 90, 180 or
/// 270 degrees clockwise, written straight into the frame's own memory.
///
/// The picture is the page as the browser drew it, upright. For a quarter turn
/// it is laid out at the turned size (1080 x 1920 for a 1920 x 1080 frame), as a
/// display output's page is. A picture of another size is scaled to fit, nearest
/// pixel; at the matching size every output pixel is exactly one input pixel.
///
/// Each pair of pixels shares its Cb and Cr, taken from the average of the two.
public final class UYVYConverter {
  public enum Failure: Error, Equatable {
    case noGPU
    case shader(String)
    case notPixelPairs(width: Int)
    case targetTooSmall
    case gpu(String)
  }

  public let device: MTLDevice
  private let queue: MTLCommandQueue
  private let pipeline: MTLComputePipelineState

  public init(device: MTLDevice? = MTLCreateSystemDefaultDevice()) throws {
    guard let device, let queue = device.makeCommandQueue() else { throw Failure.noGPU }
    self.device = device
    self.queue = queue
    do {
      // Compiled from source at run time: the Command Line Tools have no Metal
      // compiler, so a .metal file could not be built ahead of time here.
      let library = try device.makeLibrary(source: Self.shader, options: nil)
      guard let function = library.makeFunction(name: "bgraToUYVY") else { throw Failure.shader("no bgraToUYVY") }
      pipeline = try device.makeComputePipelineState(function: function)
    } catch let failure as Failure {
      throw failure
    } catch {
      throw Failure.shader(error.localizedDescription)
    }
  }

  /// A texture over a 32-bit BGRA IOSurface, sharing its memory.
  public func texture(for surface: IOSurfaceRef) -> MTLTexture? {
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .bgra8Unorm, width: IOSurfaceGetWidth(surface), height: IOSurfaceGetHeight(surface),
      mipmapped: false)
    descriptor.usage = [.shaderRead]
    descriptor.storageMode = .shared
    return device.makeTexture(descriptor: descriptor, iosurface: surface, plane: 0)
  }

  /// Convert `source` into `target`, turned by `rotation`. Returns once the GPU has
  /// written the frame.
  public func convert(_ source: MTLTexture, rotation: Rotation, into target: CardFrameTarget) throws {
    try check(width: target.width, height: target.height, rowBytes: target.rowBytes, length: target.length)
    // The frame's memory is page-aligned and a whole number of pages, so Metal maps
    // it rather than copying it. Made per frame: a buffer kept over memory that is
    // later freed would point the GPU at pages that are no longer the frame's.
    guard
      let buffer = device.makeBuffer(
        bytesNoCopy: target.bytes, length: target.length, options: .storageModeShared, deallocator: nil)
    else { throw Failure.gpu("could not make a buffer over the frame") }
    try encode(source, rotation: rotation, into: buffer, width: target.width, height: target.height, rowBytes: target.rowBytes)
  }

  /// Convert `source` into `buffer`, `rowBytes` a line, turned by `rotation`.
  /// Returns once the GPU has written it.
  public func convert(
    _ source: MTLTexture, rotation: Rotation, into buffer: MTLBuffer, width: Int, height: Int, rowBytes: Int
  ) throws {
    try check(width: width, height: height, rowBytes: rowBytes, length: buffer.length)
    try encode(source, rotation: rotation, into: buffer, width: width, height: height, rowBytes: rowBytes)
  }

  /// A buffer for `convert(_:rotation:into:width:height:rowBytes:)` that the CPU can
  /// read: shared memory, `rowBytes * height` long.
  public func makeFrameBuffer(rowBytes: Int, height: Int) throws -> MTLBuffer {
    guard let buffer = device.makeBuffer(length: rowBytes * height, options: .storageModeShared) else {
      throw Failure.gpu("could not make a buffer for the picture")
    }
    return buffer
  }

  private func check(width: Int, height: Int, rowBytes: Int, length: Int) throws {
    guard width > 0, width % 2 == 0, height > 0 else { throw Failure.notPixelPairs(width: width) }
    guard rowBytes >= width * 2, rowBytes % 4 == 0, length >= rowBytes * height else { throw Failure.targetTooSmall }
  }

  private func encode(
    _ source: MTLTexture, rotation: Rotation, into buffer: MTLBuffer, width: Int, height: Int, rowBytes: Int
  ) throws {
    guard let commands = queue.makeCommandBuffer(), let encoder = commands.makeComputeCommandEncoder() else {
      throw Failure.gpu("could not make a command buffer")
    }
    var params = Params(
      width: UInt32(width), height: UInt32(height), rowPairs: UInt32(rowBytes / 4),
      rotation: UInt32(rotation.rawValue), sourceWidth: UInt32(source.width), sourceHeight: UInt32(source.height))
    encoder.setComputePipelineState(pipeline)
    encoder.setTexture(source, index: 0)
    encoder.setBuffer(buffer, offset: 0, index: 0)
    encoder.setBytes(&params, length: MemoryLayout<Params>.stride, index: 1)
    let w = pipeline.threadExecutionWidth
    let h = max(1, pipeline.maxTotalThreadsPerThreadgroup / w)
    encoder.dispatchThreads(
      MTLSize(width: width / 2, height: height, depth: 1), threadsPerThreadgroup: MTLSize(width: w, height: h, depth: 1))
    encoder.endEncoding()
    commands.commit()
    commands.waitUntilCompleted()
    if let error = commands.error { throw Failure.gpu(error.localizedDescription) }
  }

  struct Params {
    var width: UInt32
    var height: UInt32
    var rowPairs: UInt32
    var rotation: UInt32
    var sourceWidth: UInt32
    var sourceHeight: UInt32
  }

  static let shader = """
    #include <metal_stdlib>
    using namespace metal;

    struct Params {
      uint width;
      uint height;
      uint rowPairs;
      uint rotation;
      uint sourceWidth;
      uint sourceHeight;
    };

    // Rec. 709: Kr 0.2126, Kb 0.0722. Cb = (B - Y) / 1.8556, Cr = (R - Y) / 1.5748.
    constant float3 kLuma = float3(0.2126, 0.7152, 0.0722);
    constant float kCbScale = 1.8556;
    constant float kCrScale = 1.5748;

    // The input pixel that output pixel (x, y) shows. (ux, uy) is the point in the
    // upright picture; the frame shows that picture turned clockwise.
    static uint2 sourcePixel(uint x, uint y, constant Params &p) {
      uint w = p.width, h = p.height;
      uint uw = w, uh = h, ux = x, uy = y;
      if (p.rotation == 90) {
        uw = h; uh = w; ux = y; uy = w - 1 - x;
      } else if (p.rotation == 180) {
        ux = w - 1 - x; uy = h - 1 - y;
      } else if (p.rotation == 270) {
        uw = h; uh = w; ux = h - 1 - y; uy = x;
      }
      return uint2(ux * p.sourceWidth / uw, uy * p.sourceHeight / uh);
    }

    static uchar luma8(float y) { return uchar(clamp(round(16.0 + 219.0 * y), 16.0, 235.0)); }
    static uchar chroma8(float c) { return uchar(clamp(round(128.0 + 224.0 * c), 16.0, 240.0)); }

    kernel void bgraToUYVY(texture2d<float, access::read> source [[texture(0)]],
                           device uchar4 *frame [[buffer(0)]],
                           constant Params &p [[buffer(1)]],
                           uint2 gid [[thread_position_in_grid]]) {
      if (gid.x >= p.width / 2 || gid.y >= p.height) return;
      uint x = gid.x * 2;
      float3 a = source.read(sourcePixel(x, gid.y, p)).rgb;
      float3 b = source.read(sourcePixel(x + 1, gid.y, p)).rgb;
      float3 m = (a + b) * 0.5;
      float ym = dot(m, kLuma);
      uchar cb = chroma8((m.b - ym) / kCbScale);
      uchar cr = chroma8((m.r - ym) / kCrScale);
      frame[gid.y * p.rowPairs + gid.x] = uchar4(cb, luma8(dot(a, kLuma)), cr, luma8(dot(b, kLuma)));
    }
    """
}
