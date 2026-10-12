import CryptoKit
import Foundation

/// How an output becomes a device id the server can store.
///
/// The id is `<mac device id>.<output key>`: the Mac's own id (the one the macOS
/// installer writes) with the output appended, so a screen binds to "this port on
/// this Mac" and not to the Mac.
public enum DeviceIdentity {
  /// The server refuses a device id longer than this (`clean()` in
  /// kiosk-device-routes.ts, and `MAX_STR` in kiosk-discovery.ts, which would
  /// slice a longer one and so change it between the probe and the enrolment).
  /// Counted in UTF-16 code units, as JavaScript counts a string's length.
  public static let maxLength = 128

  /// The most of the id the output key may take; the Mac's id gets the rest.
  private static let maxKeyLength = 64

  /// The output key for a display: its `CGDisplayCreateUUIDFromDisplayID` UUID,
  /// lower-cased so it reads the same as the Mac's own id.
  ///
  /// Anything outside `[a-z0-9_-]` becomes "-". The key is part of a URL path
  /// (`/api/devices/<id>/health`) and a file name (the frame dumps), and a "." in
  /// it would make the id ambiguous to anyone splitting on the separator.
  public static func outputKey(displayUUID: String) -> String {
    String(
      displayUUID.lowercased().unicodeScalars.map { scalar -> Character in
        let ok = (scalar >= "a" && scalar <= "z") || (scalar >= "0" && scalar <= "9") || scalar == "_" || scalar == "-"
        return ok ? Character(scalar) : "-"
      })
  }

  /// `<mac>.<key>`, kept under `maxLength`.
  ///
  /// A part that is too long is shortened to a prefix plus a hash of the WHOLE
  /// part, never to a bare prefix: two long ids that share their first 100
  /// characters must still be two devices, and the same input must give the same
  /// id on every launch or the binding is orphaned.
  public static func deviceId(mac: String, key: String) -> String {
    let joined = "\(mac).\(key)"
    if joined.utf16.count <= maxLength { return joined }
    let keyPart = shorten(key, to: maxKeyLength)
    let macPart = shorten(mac, to: maxLength - 1 - keyPart.utf16.count)
    return "\(macPart).\(keyPart)"
  }

  /// `part` itself when it fits, else `<prefix>~<16 hex of sha256(part)>`.
  static func shorten(_ part: String, to limit: Int) -> String {
    if part.utf16.count <= limit { return part }
    let digest = SHA256.hash(data: Data(part.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    let keep = max(0, limit - digest.count - 1)
    return "\(part.clippedUTF16(to: keep))~\(digest)"
  }
}
