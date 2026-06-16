// SSEClient.swift — Server-Sent Events client over URLSession.bytes.
//
// Mirrors the web client's EventSource on /api/events: parses `event:`/`data:`
// frames and auto-reconnects with backoff. The server emits one channel per
// event name (stage:state-changed, pco:live, propresenter:status,
// prodcom:transcript).

import Foundation

actor SSEClient {
    struct Event: Sendable {
        let channel: String
        let data: String
    }

    private let url: URL

    init(url: URL) {
        self.url = url
    }

    /// An infinite stream of decoded SSE events. Reconnects internally until the
    /// consuming Task is cancelled.
    func stream() -> AsyncStream<Event> {
        let url = self.url
        return AsyncStream { continuation in
            let task = Task {
                var backoff: UInt64 = 1
                while !Task.isCancelled {
                    do {
                        var request = URLRequest(url: url)
                        request.timeoutInterval = .infinity
                        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

                        let (bytes, response) = try await URLSession.shared.bytes(for: request)
                        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                            throw URLError(.badServerResponse)
                        }
                        backoff = 1   // connected — reset backoff

                        var channel = "message"
                        var data = ""
                        for try await line in bytes.lines {
                            if line.isEmpty {
                                if !data.isEmpty {
                                    continuation.yield(Event(channel: channel, data: data))
                                }
                                channel = "message"
                                data = ""
                            } else if line.hasPrefix("event:") {
                                channel = String(line.dropFirst("event:".count))
                                    .trimmingCharacters(in: .whitespaces)
                            } else if line.hasPrefix("data:") {
                                let chunk = String(line.dropFirst("data:".count))
                                    .trimmingCharacters(in: .whitespaces)
                                data += data.isEmpty ? chunk : "\n" + chunk
                            }
                            // ":" comment lines / unknown fields are ignored.
                        }
                    } catch {
                        // Drop through to reconnect.
                    }

                    if Task.isCancelled { break }
                    try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
                    backoff = min(backoff * 2, 10)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
