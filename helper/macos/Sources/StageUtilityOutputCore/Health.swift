import Foundation

/// The ten-second health post: `POST /api/devices/<id>/health`.
public enum HealthPost {
  public static let interval: TimeInterval = 10

  /// `{ at, dropped, fps, repeated }`, `at` in epoch milliseconds like every other
  /// timestamp the server stores. fps is rounded to 2 places.
  public static func body(_ sample: HealthSample, at: Date) -> Data {
    struct Wire: Encodable {
      var fps: Double
      var repeated: Int
      var dropped: Int
      var at: Int64
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let wire = Wire(
      fps: (sample.fps * 100).rounded() / 100, repeated: sample.repeated, dropped: sample.dropped,
      at: Int64((at.timeIntervalSince1970 * 1000).rounded()))
    return try! encoder.encode(wire)
  }

  /// How the per-output token travels. ONE line, because the server's health
  /// route decides this and may settle on something else.
  static func authenticate(_ request: inout URLRequest, token: String) {
    request.setValue(token, forHTTPHeaderField: "x-device-token")
  }

  public static func request(server: String, deviceId: String, token: String, body: Data) -> URLRequest? {
    guard let base = EnrollURL.normalise(server: server),
      let url = URL(string: "\(base)/api/devices/\(EnrollURL.encode(deviceId))/health")
    else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 5)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    authenticate(&request, token: token)
    request.httpBody = body
    return request
  }
}
