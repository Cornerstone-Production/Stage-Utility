// ServerClient.swift — thin REST client for the Stage Utility server.
//
// Used for the initial hydrate on connect. Live updates arrive over SSEClient.
// The PP/PCO hydrate endpoints exist on servers that include the live-controls
// work; callers treat them as best-effort (try?) so older servers still work —
// the SSE channels backfill the same data on the next push.

import Foundation

struct ServerClient: Sendable {
    let baseURL: URL

    func getState() async throws -> StageState {
        try await getJSON("/api/state")
    }

    func getProPresenterStatus() async throws -> ProPresenterStatusDTO {
        try await getJSON("/api/propresenter/status")
    }

    func getPcoLive() async throws -> PcoLiveDTO {
        try await getJSON("/api/pco/live")
    }

    /// Transcript backfill. Tolerant of either a bare array or `{ lines: [...] }`.
    func getTranscript() async throws -> [TranscriptLineDTO] {
        let data = try await rawGet("/api/prodcom/transcript")
        let dec = JSONDecoder()
        if let arr = try? dec.decode([TranscriptLineDTO].self, from: data) { return arr }
        struct Wrapper: Decodable { let lines: [TranscriptLineDTO]? }
        return (try? dec.decode(Wrapper.self, from: data))?.lines ?? []
    }

    /// Assign (or clear, with nil) a display's NDI source. The server persists it
    /// and broadcasts stage:state-changed, so all clients update.
    func setNDISource(displayId: String, source: String?) async throws {
        let url = baseURL.appendingPathComponent("/api/displays/\(displayId)")
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload: [String: Any] = ["ndiSource": source.map { $0 as Any } ?? NSNull()]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }

    // MARK: - Internals

    private func rawGet(_ path: String) async throws -> Data {
        let url = baseURL.appendingPathComponent(path)
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return data
    }

    private func getJSON<T: Decodable>(_ path: String) async throws -> T {
        try JSONDecoder().decode(T.self, from: await rawGet(path))
    }
}
