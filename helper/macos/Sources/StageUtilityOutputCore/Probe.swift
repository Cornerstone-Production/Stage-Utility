import Foundation

/// The UDP probe, as `install-macos.sh` sends it plus the `output` object.
///
/// The server decodes it in kiosk-discovery.ts (`decodeProbe`): every string is
/// cut to 128 characters there, `macs` to 8, and a datagram over 2048 bytes is
/// not read at all. This side clips the strings the same way so what is sent is
/// what is heard.
public struct Probe: Equatable {
  /// `<mac device id>.<output key>`.
  public var id: String
  public var macs: [String]
  public var hostname: String
  public var os: String
  /// The server that answered us last, if any.
  public var boundTo: String?
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

  public init(id: String, macs: [String], hostname: String, os: String = "macOS", boundTo: String? = nil, output: Output) {
    self.id = id
    self.macs = macs
    self.hostname = hostname
    self.os = os
    self.boundTo = boundTo
    self.output = output
  }

  public init(id: String, macs: [String], hostname: String, boundTo: String?, descriptor: OutputDescriptor) {
    self.init(
      id: id, macs: macs, hostname: hostname, boundTo: boundTo,
      output: Output(kind: descriptor.kind, name: descriptor.name, port: descriptor.port, modes: descriptor.modes))
  }

  /// The server's own bounds, repeated here.
  public static let maxString = 128
  public static let maxMacs = 8
  public static let maxDatagram = 2048

  /// The datagram. Keys are sorted so the bytes are the same on every run, which
  /// is what lets a test pin them.
  public func encoded() -> Data {
    let wire = Wire(
      stageUtility: "discover", v: 1,
      id: Probe.clip(id),
      macs: macs.prefix(Probe.maxMacs).map { Probe.clip($0) },
      hostname: Probe.clip(hostname), os: Probe.clip(os),
      boundTo: boundTo.map { Probe.clip($0) },
      output: Wire.Out(
        kind: output.kind.rawValue, name: Probe.clip(output.name), port: Probe.clip(output.port),
        modes: output.modes.map { $0.map { Probe.clip($0) } }))
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // A struct of strings, ints and arrays of strings: encoding cannot fail.
    return try! encoder.encode(wire)
  }

  static func clip(_ s: String) -> String { String(s.prefix(maxString)) }

  private struct Wire: Encodable {
    var stageUtility: String
    var v: Int
    var id: String
    var macs: [String]
    var hostname: String
    var os: String
    var boundTo: String?
    var output: Out

    struct Out: Encodable {
      var kind: String
      var name: String
      var port: String
      var modes: [String]?
    }
  }
}
