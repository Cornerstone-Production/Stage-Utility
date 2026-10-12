import Foundation

extension String {
  /// At most `limit` UTF-16 code units, cut between characters' scalars so no
  /// half of a surrogate pair is left behind.
  ///
  /// The server's limits are JavaScript string lengths, which count UTF-16 code
  /// units: an emoji is 2, a CJK character 1, a letter 1. Swift's `count` counts
  /// grapheme clusters and `utf8.count` bytes, and either disagrees with the
  /// server on exactly the names (a display called after a person, in another
  /// script) where it matters.
  public func clippedUTF16(to limit: Int) -> String {
    if utf16.count <= limit { return self }
    var out = String.UnicodeScalarView()
    var units = 0
    for scalar in unicodeScalars {
      let n = scalar.value > 0xFFFF ? 2 : 1
      if units + n > limit { break }
      out.append(scalar)
      units += n
    }
    return String(out)
  }
}

extension String {
  /// The text a C call wrote into `buffer`, up to its first NUL, as UTF-8.
  public init(nulTerminated buffer: [CChar]) {
    self = String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }
}
