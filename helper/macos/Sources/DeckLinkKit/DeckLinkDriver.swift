import DeckLinkShim
import Foundation
import StageUtilityOutputCore

/// Blackmagic's Desktop Video driver, and the DeckLink ports it offers.
///
/// The driver is the user's install (`/Library/Frameworks/DeckLinkAPI.framework`),
/// loaded when first asked. Without it there are no ports, and the helper offers
/// display outputs only.
public enum DeckLinkDriver {
  public enum Status: Equatable {
    case notInstalled
    case installed(version: String)
    /// Older than the SDK the helper is built with (12.0).
    case tooOld(version: String)
    /// The framework is on disk but its API would not load.
    case unusable

    /// What to tell the operator when DeckLink outputs are unavailable; nil when the
    /// driver is fine.
    public var problem: String? {
      switch self {
      case .installed:
        return nil
      case .notInstalled:
        return "Desktop Video is not installed, so there are no DeckLink outputs; install it and restart the helper"
      case .tooOld(let version):
        return "Desktop Video \(version) is older than 12.0, so there are no DeckLink outputs; update it and restart the helper"
      case .unusable:
        return "Desktop Video is installed but its API would not load, so there are no DeckLink outputs; reinstall it and restart the helper"
      }
    }
  }

  public static func status() -> Status {
    var info = dl_driver_info()
    dl_driver_get(&info)
    let version = cString(&info.version_string, fallback: versionText(info.version))
    switch info.state {
    case DL_DRIVER_INSTALLED: return .installed(version: version)
    case DL_DRIVER_TOO_OLD: return .tooOld(version: version)
    case DL_DRIVER_UNUSABLE: return .unusable
    default: return .notInstalled
    }
  }

  /// Every port that can play out, with its modes. Empty without a driver.
  public static func ports() -> [DeckLinkPort] {
    guard let list = dl_port_list_create() else { return [] }
    defer { dl_port_list_free(list) }
    var ports: [DeckLinkPort] = []
    for p in 0..<dl_port_list_count(list) {
      var info = dl_port_info()
      guard dl_port_list_port(list, p, &info) else { continue }
      var modes: [CardMode] = []
      for m in 0..<info.mode_count {
        var mode = dl_mode()
        guard dl_port_list_mode(list, p, m, &mode) else { continue }
        modes.append(CardMode(mode))
      }
      ports.append(
        DeckLinkPort(
          id: DeckLinkPortID(info.id), displayName: cString(&info.display_name, fallback: ""),
          modelName: cString(&info.model_name, fallback: ""), modes: modes))
    }
    return ports
  }

  /// Call `changed` whenever a DeckLink device arrives or goes, on the driver's
  /// thread. An open port on a device that goes has already been told. False
  /// without a driver.
  @discardableResult
  public static func watchDevices(_ changed: @escaping () -> Void) -> Bool {
    DeviceListener.shared.handler = changed
    return dl_watch_devices({ _ in DeviceListener.shared.fire() }, nil)
  }

  /// "12.4.1" from 0x0c040100.
  static func versionText(_ v: Int64) -> String {
    guard v > 0 else { return "unknown" }
    let major = (v >> 24) & 0xff
    let minor = (v >> 16) & 0xff
    let patch = (v >> 8) & 0xff
    return patch == 0 ? "\(major).\(minor)" : "\(major).\(minor).\(patch)"
  }
}

/// Which port: a card's persistent id (or, for a card that has none, where it sits
/// on the bus) and the sub-device, one per connector on a multi-port card.
public struct DeckLinkPortID: Hashable {
  public var persistentID: Int64?
  public var topologicalID: Int64?
  public var subDevice: Int64

  public init(persistentID: Int64?, topologicalID: Int64? = nil, subDevice: Int64) {
    self.persistentID = persistentID
    self.topologicalID = topologicalID
    self.subDevice = subDevice
  }

  init(_ id: dl_port_id) {
    persistentID = id.has_persistent_id ? id.persistent_id : nil
    topologicalID = id.has_topological_id ? id.topological_id : nil
    subDevice = id.sub_device
  }

  var shim: dl_port_id {
    dl_port_id(
      has_persistent_id: persistentID != nil, persistent_id: persistentID ?? 0,
      has_topological_id: topologicalID != nil, topological_id: topologicalID ?? 0, sub_device: subDevice)
  }

  /// The output key, the part of the device id after the Mac's: stable across
  /// reboots and re-plugging, and inside `[a-z0-9_-]` like a display's.
  /// `decklink-<persistent id in hex>-<sub-device>`; a card with no persistent id
  /// gets `decklink-t<topological id>-<sub-device>`, which holds while it stays in
  /// the same slot.
  public var outputKey: String {
    if let persistentID { return "decklink-\(hex(persistentID))-\(subDevice)" }
    if let topologicalID { return "decklink-t\(hex(topologicalID))-\(subDevice)" }
    return "decklink-unknown-\(subDevice)"
  }

  private func hex(_ v: Int64) -> String { String(UInt64(bitPattern: v), radix: 16) }
}

/// A port that can play out, as the driver reports it.
public struct DeckLinkPort: Equatable {
  public var id: DeckLinkPortID
  /// The driver's name for the port, "DeckLink Quad 2 (3)".
  public var displayName: String
  public var modelName: String
  public var modes: [CardMode]

  public init(id: DeckLinkPortID, displayName: String, modelName: String, modes: [CardMode]) {
    self.id = id
    self.displayName = displayName
    self.modelName = modelName
    self.modes = modes
  }

  /// The output as the server is told about it.
  public var descriptor: OutputDescriptor {
    let label = !displayName.isEmpty ? displayName : (!modelName.isEmpty ? modelName : "DeckLink \(id.subDevice + 1)")
    return OutputDescriptor(
      kind: .decklink, key: id.outputKey, name: label, port: label, modes: VideoModes.offered(by: modes))
  }
}

extension CardMode {
  init(_ m: dl_mode) {
    var m = m
    let field: FieldOrder
    switch m.field {
    case DL_FIELD_PROGRESSIVE: field = .progressive
    case DL_FIELD_UPPER_FIRST: field = .upperFirst
    case DL_FIELD_LOWER_FIRST: field = .lowerFirst
    case DL_FIELD_PSF: field = .segmented
    default: field = .unknown
    }
    self.init(
      code: m.display_mode, driverName: cString(&m.name, fallback: ""), width: Int(m.width), height: Int(m.height),
      frameDuration: m.frame_duration, timeScale: m.time_scale, field: field, supportsYUV8: m.yuv8)
  }
}

/// A fixed C char array (imported as a tuple) as a String.
func cString<T>(_ tuple: inout T, fallback: String) -> String {
  let s = withUnsafeBytes(of: &tuple) { raw -> String in
    let bytes = raw.bindMemory(to: UInt8.self)
    let end = bytes.firstIndex(of: 0) ?? bytes.count
    return String(decoding: bytes[..<end], as: UTF8.self)
  }
  return s.isEmpty ? fallback : s
}

/// The one device-change handler the shim's C callback reaches.
private final class DeviceListener {
  static let shared = DeviceListener()
  private let lock = NSLock()
  private var _handler: (() -> Void)?

  var handler: (() -> Void)? {
    get { lock.withLock { _handler } }
    set { lock.withLock { _handler = newValue } }
  }

  func fire() { handler?() }
}

/// The driver and its ports, scanned when asked, logged only when they change: the
/// driver missing (once, not on every scan), a driver found, the ports it offers.
public final class DeckLinkInventory {
  public typealias Reader = () -> (DeckLinkDriver.Status, [DeckLinkPort])

  private let read: Reader
  private let log: (DeckLinkLog.Level, String) -> Void
  private let lock = NSLock()
  private var last: (status: DeckLinkDriver.Status, keys: [String])?

  public init(
    read: @escaping Reader = { (DeckLinkDriver.status(), DeckLinkDriver.ports()) },
    log: @escaping (DeckLinkLog.Level, String) -> Void = DeckLinkLog.write
  ) {
    self.read = read
    self.log = log
  }

  /// The ports now. Call at launch and when a device arrives or goes.
  public func scan() -> (status: DeckLinkDriver.Status, ports: [DeckLinkPort]) {
    let (status, ports) = read()
    let keys = ports.map(\.id.outputKey)
    lock.withLock {
      defer { last = (status, keys) }
      if let last, last.status == status, last.keys == keys { return }
      if let problem = status.problem {
        log(.error, problem)
      } else if case .installed(let version) = status {
        let names = ports.map { "\($0.descriptor.name) (\($0.id.outputKey))" }
        log(.info, "Desktop Video \(version): \(ports.count) output port\(ports.count == 1 ? "" : "s")"
          + (names.isEmpty ? "" : ": " + names.joined(separator: ", ")))
      }
    }
    return (status, ports)
  }
}
