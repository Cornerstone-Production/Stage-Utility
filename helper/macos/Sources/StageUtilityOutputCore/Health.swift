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

  public static func request(server: String, deviceId: String, token: String, body: Data) -> URLRequest? {
    guard let base = EnrollURL.normalise(server: server),
      let url = URL(string: "\(base)/api/devices/\(EnrollURL.encode(deviceId))/health")
    else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 5)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(token, forHTTPHeaderField: "x-device-token")
    request.httpBody = body
    return request
  }
}

/// How the server answered one health post, or that it did not.
///
/// What the server's health route (`POST /api/devices/:id/health`) means by its
/// statuses: 404 is "no device is set up with that id", which is how an output
/// that was released in Screens answers; 401 is a missing or wrong secret; 400 is
/// a body that is not a report. None of them says anything about any OTHER output.
public enum HealthOutcome: Equatable {
  case accepted
  /// 404: this output has no screen set up on the server.
  case unknownDevice
  /// 401: the server refused this output's token.
  case unauthorised
  /// Any other HTTP status, 400 included.
  case rejected(Int)
  /// No answer at all.
  case unreachable(String)

  public static func from(status: Int) -> HealthOutcome {
    switch status {
    case 200..<300: return .accepted
    case 404: return .unknownDevice
    case 401: return .unauthorised
    default: return .rejected(status)
    }
  }
}

/// What one output does about the health posts it sends: whether it is due to post,
/// what an answer means for the next one, and what is worth saying.
///
/// Per output. A 404 or a 401 is that output's own problem, so it pauses that
/// output's posting and no other's, with a wait that grows (30 s, then 60, 120 and
/// 300) so an output the server no longer knows is not asking every ten seconds. It
/// posts again when the wait is over, or at once when its screen is set up again.
public struct HealthGate: Equatable {
  public enum Pause: Equatable {
    case unknownDevice
    case unauthorised
  }

  /// What a result is worth telling a person: transitions only, never a repeat.
  public enum Event: Equatable {
    case none
    /// Accepted after failing or being paused.
    case recovered
    /// The first pause of a run, and how long until the next try.
    case paused(Pause, retryIn: TimeInterval)
    /// The first failure of a run, and why.
    case failing(String)
    /// The server has not answered `misses` posts in a row: look for it again.
    case rediscover(misses: Int)
  }

  /// Set from a 404 or 401 until a post is accepted or the screen is set up again.
  /// It stays through the wait AND the retry that follows it, so a status line can
  /// say so throughout.
  public private(set) var pause: Pause?
  private var pausedUntil: Date?
  private var level = 0
  private var failing = false
  private var misses = 0

  public init() {}

  /// 30, 60, 120, then 300 s for good.
  public static func pauseDelay(level: Int) -> TimeInterval {
    switch max(1, level) {
    case 1: return 30
    case 2: return 60
    case 3: return 120
    default: return 300
    }
  }

  /// Whether a post may go now.
  public func isDue(at now: Date) -> Bool {
    guard let pausedUntil else { return true }
    return now >= pausedUntil
  }

  public mutating func record(_ outcome: HealthOutcome, at now: Date) -> Event {
    switch outcome {
    case .accepted:
      let wasUnwell = failing || pause != nil
      clearPause()
      failing = false
      misses = 0
      return wasUnwell ? .recovered : .none
    case .unknownDevice:
      return enterPause(.unknownDevice, at: now)
    case .unauthorised:
      return enterPause(.unauthorised, at: now)
    case .rejected(let status):
      // The server is there and knows this output; the post itself was wrong.
      clearPause()
      misses = 0
      return startFailing("the server refused a health post (HTTP \(status))")
    case .unreachable(let why):
      misses += 1
      let first = startFailing("health post failed: \(why)")
      if first != .none { return first }
      return Backoff.shouldRediscover(afterFailureNumber: misses) ? .rediscover(misses: misses) : .none
    }
  }

  /// This output's screen is set up (again): post at once, from the start.
  public mutating func boundAgain() {
    clearPause()
  }

  private mutating func enterPause(_ kind: Pause, at now: Date) -> Event {
    misses = 0
    failing = false
    level += 1
    let wait = HealthGate.pauseDelay(level: level)
    pausedUntil = now.addingTimeInterval(wait)
    let changed = pause != kind
    pause = kind
    return changed ? .paused(kind, retryIn: wait) : .none
  }

  private mutating func startFailing(_ why: String) -> Event {
    if failing { return .none }
    failing = true
    return .failing(why)
  }

  private mutating func clearPause() {
    pause = nil
    pausedUntil = nil
    level = 0
  }
}

/// One gate per output, by output key. There is deliberately no gate for "all
/// outputs": what one output is told is that output's.
public struct HealthBoard: Equatable {
  private var gates: [String: HealthGate] = [:]

  public init() {}

  public func pause(for key: String) -> HealthGate.Pause? { gates[key]?.pause }

  public func isDue(_ key: String, at now: Date) -> Bool { gates[key]?.isDue(at: now) ?? true }

  public mutating func record(_ outcome: HealthOutcome, for key: String, at now: Date) -> HealthGate.Event {
    var gate = gates[key] ?? HealthGate()
    let event = gate.record(outcome, at: now)
    gates[key] = gate
    return event
  }

  public mutating func boundAgain(_ key: String) { gates[key]?.boundAgain() }

  /// An output went away or was turned off: nothing it learned carries over.
  public mutating func forget(_ key: String) { gates[key] = nil }
}
