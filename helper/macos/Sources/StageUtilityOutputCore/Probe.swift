import Foundation

/// The UDP probe a Mac's Chrome kiosk sends, plus the `output` object.
///
/// The server decodes it in kiosk-discovery.ts (`decodeProbe`): every string is
/// cut to 128 UTF-16 code units there (JavaScript's `.slice`, which counts units,
/// not characters or bytes), `macs` to 8, and a datagram over 2048 BYTES is not
/// read at all. This side clips the strings the same way so what is sent is what
/// is heard, and sends less rather than a datagram the server would drop whole.
public struct Probe: Equatable {
  /// `<mac device id>.<output key>`.
  public var id: String
  public var macs: [String]
  public var hostname: String
  public var os: String
  /// The server that answered us last, if any.
  public var boundTo: String?
  /// The server this output is bound to has not answered for a while. It lets
  /// another server list the output as "bound elsewhere" (`decideProbe` in
  /// kiosk-discovery.ts), as the Linux agent's probe does. Absent unless true.
  public var unreachable: Bool
  public var output: Output

  public struct Output: Equatable {
    public var kind: OutputKind
    public var name: String
    public var port: String
    public var modes: [String]?

    public init(kind: OutputKind, name: String, port: String, modes: [String]? = nil) {
      self.kind = kind
      self.name = name
      self.port = port
      self.modes = modes
    }
  }

  public init(
    id: String, macs: [String], hostname: String, os: String = "macOS", boundTo: String? = nil,
    unreachable: Bool = false, output: Output
  ) {
    self.id = id
    self.macs = macs
    self.hostname = hostname
    self.os = os
    self.boundTo = boundTo
    self.unreachable = unreachable
    self.output = output
  }

  public init(
    id: String, macs: [String], hostname: String, boundTo: String?, unreachable: Bool = false,
    descriptor: OutputDescriptor
  ) {
    self.init(
      id: id, macs: macs, hostname: hostname, boundTo: boundTo, unreachable: unreachable,
      output: Output(kind: descriptor.kind, name: descriptor.name, port: descriptor.port, modes: descriptor.modes))
  }

  /// The server's own bounds, repeated here. Lengths are UTF-16 code units.
  public static let maxString = 128
  public static let maxMacs = 8
  public static let maxModes = 24
  public static let maxModeLength = 32
  public static let maxDatagram = 2048

  /// The datagram. Keys are sorted so the bytes are the same on every run, which
  /// is what lets a test pin them.
  ///
  /// Always within `maxDatagram` bytes. A name or a hostname of multi-byte
  /// characters can push a probe past it, and the server then reads none of it, so
  /// the output would never appear. What is least needed goes first: the long name
  /// (the server falls back to the port), the modes, the MACs beyond the first, then
  /// the Mac's own descriptive strings. The id and the binding are never cut: they
  /// are what the output is.
  public func encoded() -> Data {
    var last = Data()
    for tier in 0...4 {
      last = encode(tier: tier)
      if last.count <= Probe.maxDatagram { return last }
    }
    return last
  }

  private func encode(tier: Int) -> Data {
    let name = tier >= 1 ? output.port : output.name
    let modes = tier >= 2 ? nil : output.modes
    let macList = tier >= 4 ? [] : Array(macs.prefix(tier >= 3 ? 1 : Probe.maxMacs))
    let describe = tier >= 4 ? 32 : Probe.maxString
    let wire = Wire(
      stageUtility: "discover", v: 1,
      id: Probe.clip(id),
      macs: macList.map { Probe.clip($0) },
      hostname: Probe.clip(hostname, to: describe), os: Probe.clip(os, to: describe),
      boundTo: boundTo.map { Probe.clip($0) },
      unreachable: unreachable ? true : nil,
      output: Wire.Out(
        kind: output.kind.rawValue, name: Probe.clip(name, to: describe), port: Probe.clip(output.port, to: describe),
        modes: modes.map { $0.prefix(Probe.maxModes).map { Probe.clip($0, to: Probe.maxModeLength) } }))
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // A struct of strings, ints and arrays of strings: encoding cannot fail.
    return try! encoder.encode(wire)
  }

  static func clip(_ s: String, to limit: Int = maxString) -> String { s.clippedUTF16(to: limit) }

  private struct Wire: Encodable {
    var stageUtility: String
    var v: Int
    var id: String
    var macs: [String]
    var hostname: String
    var os: String
    var boundTo: String?
    var unreachable: Bool?
    var output: Out

    struct Out: Encodable {
      var kind: String
      var name: String
      var port: String
      var modes: [String]?
    }
  }
}
