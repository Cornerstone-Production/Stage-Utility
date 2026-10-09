import Foundation

/// The page `--test-pattern latency` shows instead of a server's screen: a large
/// clock, a frame counter and a moving bar, for measuring how far an output's
/// picture runs behind real time.
///
/// Every output that shows it reads the same clock, `performance.timeOrigin` plus
/// the animation frame's timestamp: the time the browser began that frame, on the
/// Mac's own clock. A photograph of two outputs side by side shows the difference
/// between their delays, monitors included.
///
/// The page also writes that time into its top-left corner as a row of black and
/// white blocks (`Stamp`), so the helper can read, from each picture, exactly when
/// its content was drawn, and work out how long it took to reach the card.
public enum LatencyPage {
  /// The page as a `data:` URL: nothing to serve, and nothing on the network.
  public static var url: URL {
    URL(string: "data:text/html;base64," + Data(html.utf8).base64EncodedString())!
  }

  /// The stamp in the page's top-left corner: `Stamp.blocks` squares of
  /// `Stamp.blockSize` pixels in a row, white for 1 and black for 0, most
  /// significant bit first:
  ///
  /// - 8 marker bits, `Stamp.marker`, so a page that is not this one never reads
  ///   as a stamp;
  /// - 40 bits: the frame's time in microseconds since the Unix epoch, modulo 2^40
  ///   (about 12.7 days);
  /// - 8 bits: the sum of those five bytes, modulo 256.
  public enum Stamp {
    public static let blockSize = 16
    public static let blocks = 56
    public static let marker: UInt8 = 0b1011_0010
    public static let modulus: UInt64 = 1 << 40

    /// The stamp's time, in microseconds since the epoch modulo 2^40, from `bit(i)`,
    /// which says whether block `i` is white. Nil when the marker or the checksum
    /// does not match, or a block cannot be read.
    public static func decode(_ bit: (Int) -> Bool?) -> UInt64? {
      var bits: [Bool] = []
      bits.reserveCapacity(blocks)
      for i in 0..<blocks {
        guard let b = bit(i) else { return nil }
        bits.append(b)
      }
      func byte(_ at: Int) -> UInt8 { (0..<8).reduce(0) { $0 << 1 | (bits[at + $1] ? 1 : 0) } }
      guard byte(0) == marker else { return nil }
      let bytes = (0..<5).map { byte(8 + $0 * 8) }
      guard byte(48) == UInt8(truncatingIfNeeded: bytes.reduce(0) { $0 + Int($1) }) else { return nil }
      return bytes.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
    }

    /// The bits for `micros` (microseconds since the epoch), as the page draws them.
    public static func encode(_ micros: UInt64) -> [Bool] {
      let t = micros % modulus
      let bytes = (0..<5).map { UInt8(truncatingIfNeeded: t >> (32 - 8 * $0)) }
      let sum = UInt8(truncatingIfNeeded: bytes.reduce(0) { $0 + Int($1) })
      return ([marker] + bytes + [sum]).flatMap { b in (0..<8).map { b >> (7 - $0) & 1 == 1 } }
    }

    /// The whole time back from a stamp, given a time near it in the same clock
    /// (microseconds since the epoch): the one that is equal to the stamp modulo
    /// 2^40 and nearest `near`.
    public static func unwrap(_ stamp: UInt64, near: UInt64) -> UInt64 {
      let base = near - near % modulus
      let candidates = [base &- modulus &+ stamp, base &+ stamp, base &+ modulus &+ stamp]
      return candidates.min { distance($0, near) < distance($1, near) }!
    }

    private static func distance(_ a: UInt64, _ b: UInt64) -> UInt64 { a > b ? a - b : b - a }

    /// When a stamp's content was drawn, on the host clock: the stamp is on the
    /// epoch clock the page reads, so it is placed by how long before the epoch
    /// time `epochNowMicros` it was, taken back from the host time `hostNowNs` read
    /// at the same moment.
    public static func hostNs(of stamp: UInt64, epochNowMicros: UInt64, hostNowNs: UInt64) -> UInt64 {
      let drawn = Int64(bitPattern: unwrap(stamp, near: epochNowMicros))
      let agoNs = (Int64(bitPattern: epochNowMicros) - drawn) * 1000
      return UInt64(max(0, Int64(bitPattern: hostNowNs) - agoNs))
    }
  }

  public static let html = """
    <!doctype html>
    <html><head><meta charset="utf-8"><title>Latency test</title>
    <style>
    html, body { margin: 0; height: 100%; background: #000; color: #fff; overflow: hidden;
      font-family: -apple-system, Helvetica, Arial, sans-serif; }
    #stamp { position: absolute; left: 0; top: 0; image-rendering: pixelated; }
    #clock { position: absolute; left: 0; right: 0; top: 18%; text-align: center; font-size: 24vh;
      font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
    #time { position: absolute; left: 0; right: 0; top: 52%; text-align: center; font-size: 6vh;
      font-variant-numeric: tabular-nums; color: #bbb; }
    #frame { position: absolute; left: 0; right: 0; top: 62%; text-align: center; font-size: 5vh;
      font-variant-numeric: tabular-nums; color: #888; }
    #track { position: absolute; left: 0; right: 0; top: 76%; height: 14vh; background: #222; }
    #bar { position: absolute; top: 0; height: 100%; width: 2%; background: #fff; }
    #ticks { position: absolute; left: 0; right: 0; top: 91%; height: 3vh;
      background: repeating-linear-gradient(90deg, #666 0 2px, transparent 2px 10%); }
    </style></head>
    <body>
    <canvas id="stamp" width="\(Stamp.blocks * Stamp.blockSize)" height="\(Stamp.blockSize)"></canvas>
    <div id="clock"></div><div id="time"></div><div id="frame"></div>
    <div id="track"><div id="bar"></div></div><div id="ticks"></div>
    <script>
    const B = \(Stamp.blockSize), MARKER = \(Stamp.marker), MOD = \(Stamp.modulus);
    const stamp = document.getElementById("stamp").getContext("2d");
    const clock = document.getElementById("clock"), time = document.getElementById("time");
    const frame = document.getElementById("frame"), bar = document.getElementById("bar");
    let n = 0;
    function bits(us) {
      let t = us % MOD;
      const bytes = [];
      for (let i = 4; i >= 0; i--) { bytes[i] = t % 256; t = Math.floor(t / 256); }
      const sum = bytes.reduce((a, b) => a + b, 0) % 256;
      return [MARKER, ...bytes, sum].flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((s) => (b >> s) & 1));
    }
    function draw(ts) {
      const ms = performance.timeOrigin + ts;
      const us = Math.round(ms * 1000);
      bits(us).forEach((b, i) => { stamp.fillStyle = b ? "#fff" : "#000"; stamp.fillRect(i * B, 0, B, B); });
      const d = new Date(ms);
      const p = (v, w) => String(v).padStart(w, "0");
      clock.textContent = p(d.getSeconds(), 2) + "." + p(d.getMilliseconds(), 3);
      time.textContent = p(d.getHours(), 2) + ":" + p(d.getMinutes(), 2) + ":" + p(d.getSeconds(), 2) + "."
        + p(d.getMilliseconds(), 3);
      frame.textContent = "frame " + (n++);
      bar.style.left = ((ms % 1000) / 1000 * 98) + "%";
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
    </script>
    </body></html>
    """
}
