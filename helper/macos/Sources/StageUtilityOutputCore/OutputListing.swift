import Foundation

/// `--list-outputs`: what the helper has stored, and what it would do. It only
/// reads. A Mac with no device id yet has none shown, rather than one made for the
/// occasion and saved.
public enum OutputListing {
  public static func lines(
    identity: MacIdentity?, displays: [OutputDescriptor], record: (String) -> OutputRecord?, readProblem: String? = nil
  ) -> [String] {
    var out: [String] = []
    if let identity {
      out.append("mac device id: \(identity.deviceId) (\(identity.source == .installer ? "installer" : "generated"))")
    } else {
      out.append("mac device id: none yet (the helper makes one the first time it runs)")
    }
    if let readProblem { out.append("state: \(readProblem); nothing is saved until it is fixed") }
    for d in displays {
      let id = identity.map { mac in record(d.key)?.deviceId(mac: mac.deviceId, key: d.key) ?? DeviceIdentity.deviceId(mac: mac.deviceId, key: d.key) } ?? "-"
      let state: String
      if let r = record(d.key) {
        state = "\(r.enabled ? "on" : "off") (stored)"
      } else {
        state = "default \(defaultEnabled(kind: d.kind, isMain: d.isMain) ? "on" : "off") (not stored yet)"
      }
      out.append("\(d.key)\t\(id)\t\(d.name)\t\(state)")
    }
    return out
  }
}
