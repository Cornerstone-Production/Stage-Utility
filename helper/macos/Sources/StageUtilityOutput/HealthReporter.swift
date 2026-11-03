import Foundation
import StageUtilityOutputCore

/// How the server answered one health post, and what it said about the output's
/// switch: nil when the answer had none (a server older than the switch, or a post
/// that was not accepted).
struct HealthReply {
  var outcome: HealthOutcome
  var enabled: Bool?
}

enum HealthReporter {
  /// Post one sample and say what came back. What an answer means is
  /// `HealthOutcome.from(status:)`, decided in the core library.
  static func post(_ request: URLRequest) async -> HealthReply {
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse else { return HealthReply(outcome: .rejected(0)) }
      let outcome = HealthOutcome.from(status: http.statusCode)
      return HealthReply(outcome: outcome, enabled: outcome == .accepted ? OutputSwitch.answer(in: data) : nil)
    } catch {
      return HealthReply(outcome: .unreachable(error.localizedDescription))
    }
  }

  /// The server's screens, from `GET /api/outputs`: names, and the rotation each
  /// carries. Throws why it could not be read; the caller decides what to say.
  static func screens(server: String) async throws -> [ScreenRecord] {
    guard let base = EnrollURL.normalise(server: server), let url = URL(string: "\(base)/api/outputs") else {
      throw ScreenList.ReadError.notAList
    }
    var request = URLRequest(url: url, timeoutInterval: 5)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    return try ScreenList.parse(status: status, body: data).get()
  }
}
