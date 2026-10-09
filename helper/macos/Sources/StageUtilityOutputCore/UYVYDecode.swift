import Foundation

/// 8-bit UYVY 4:2:2, Rec. 709 video range, back to 8-bit RGBA: what `--dump-frames`
/// writes for a card output, so the dump is the frame the card is sent (the Metal
/// conversion, the turn and the scaling included), not the page before them.
///
/// The inverse of `UYVYConverter`: Y 16-235 and Cb, Cr 16-240 to full range, each
/// pixel of a pair with the pair's shared chroma.
public enum UYVYDecode {
  /// `bytes` holds `height` lines of `rowBytes`, each starting with `width / 2`
  /// pairs of (Cb, Y0, Cr, Y1). Returns `width * height * 4` bytes, R G B A, alpha
  /// 255; empty when `bytes` is too short or the width is odd.
  public static func rgba(_ bytes: [UInt8], width: Int, height: Int, rowBytes: Int) -> [UInt8] {
    guard width > 0, width % 2 == 0, height > 0, rowBytes >= width * 2, bytes.count >= rowBytes * (height - 1) + width * 2
    else { return [] }
    var out = [UInt8](repeating: 255, count: width * height * 4)
    for y in 0..<height {
      let line = y * rowBytes
      for pair in 0..<(width / 2) {
        let at = line + pair * 4
        let cb = (Double(bytes[at]) - 128) / 224
        let cr = (Double(bytes[at + 2]) - 128) / 224
        for (n, luma) in [bytes[at + 1], bytes[at + 3]].enumerated() {
          let l = (Double(luma) - 16) / 219
          let r = l + 1.5748 * cr
          let b = l + 1.8556 * cb
          let g = (l - 0.2126 * r - 0.0722 * b) / 0.7152
          let px = (y * width + pair * 2 + n) * 4
          out[px] = byte(r)
          out[px + 1] = byte(g)
          out[px + 2] = byte(b)
        }
      }
    }
    return out
  }

  private static func byte(_ v: Double) -> UInt8 { UInt8(max(0, min(255, (v * 255).rounded()))) }
}
