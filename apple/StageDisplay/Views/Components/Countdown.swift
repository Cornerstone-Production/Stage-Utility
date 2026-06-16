// Countdown.swift — PCO live countdown math. Mirrors the web client: PCO's timer
// always counts DOWN (to service start before service, then per item), correcting
// for client/server clock skew using PcoLiveDTO.serverNow.

import Foundation

enum Countdown {
    /// Seconds remaining for the given live state at `now` (device clock).
    /// Positive = time left, negative = overtime, nil = nothing to count.
    static func remaining(_ live: PcoLiveDTO, now: Date = Date()) -> TimeInterval? {
        guard let serverNow = parseISO(live.serverNow) else { return nil }
        let skew = serverNow.timeIntervalSince(now)        // server − device
        let serverTimeNow = now.addingTimeInterval(skew)

        switch live.mode {
        case .none:
            return nil
        case .preservice:
            guard let target = parseISO(live.targetAt) else { return nil }
            return target.timeIntervalSince(serverTimeNow)
        case .item:
            guard let start = parseISO(live.liveStartAt), let len = live.lengthSec else { return nil }
            return start.addingTimeInterval(len).timeIntervalSince(serverTimeNow)
        }
    }

    /// "M:SS" / "H:MM:SS", prefixed "-" when overtime.
    static func format(_ seconds: TimeInterval) -> String {
        let negative = seconds < 0
        let total = Int(abs(seconds).rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        let body = h > 0
            ? String(format: "%d:%02d:%02d", h, m, s)
            : String(format: "%d:%02d", m, s)
        return negative ? "-\(body)" : body
    }

    // ISO8601 with or without fractional seconds (toISOString() includes ms).
    private static func parseISO(_ string: String?) -> Date? {
        guard let string else { return nil }
        return isoFractional.date(from: string) ?? isoPlain.date(from: string)
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain = ISO8601DateFormatter()
}
