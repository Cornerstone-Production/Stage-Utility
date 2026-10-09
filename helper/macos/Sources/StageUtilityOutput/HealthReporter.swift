import Foundation
import StageUtilityOutputCore

enum HealthReporter {
  /// Post one sample and say what came back. What an answer means is
  /// `HealthOutcome.from(status:)`, decided in the core library.
  static func post(_ request: URLRequest) async -> HealthOutcome {
    do {
      let (_, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse else { return .rejected(0) }
      return HealthOutcome.from(status: http.statusCode)
    } catch {
      return .unreachable(error.localizedDescription)
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
