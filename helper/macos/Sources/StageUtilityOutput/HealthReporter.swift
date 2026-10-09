import Foundation
import StageUtilityOutputCore

/// Posts one health sample. The decisions about what a result means are the
/// caller's; this only says what happened.
enum HealthOutcome {
  case accepted
  /// 404: the server has no health route. Stop posting for this run.
  case unsupported
  /// Any other HTTP status.
  case rejected(Int)
  /// The request never got an answer.
  case unreachable(NSError)
}

enum HealthReporter {
  static func post(_ request: URLRequest) async -> HealthOutcome {
    do {
      let (_, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse else { return .rejected(0) }
      switch http.statusCode {
      case 200..<300: return .accepted
      case 404: return .unsupported
      default: return .rejected(http.statusCode)
      }
    } catch {
      return .unreachable(error as NSError)
    }
  }

  /// The name of the screen an output id belongs to, from `GET /api/outputs`.
  /// Throws the failure to the caller, who decides what to say about it.
  static func screenName(server: String, outputRef: String) async throws -> String? {
    guard let base = EnrollURL.normalise(server: server), let url = URL(string: "\(base)/api/outputs") else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 5)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let (data, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200,
      let list = try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { return nil }
    let match = list.first { ($0["id"] as? String) == outputRef || ($0["slug"] as? String) == outputRef }
    return match?["name"] as? String
  }
}
