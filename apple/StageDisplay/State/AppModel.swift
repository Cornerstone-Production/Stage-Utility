// AppModel.swift — the single observable store. Holds the server connection and
// the live state (StageState + PCO live + ProPresenter + transcript), fed by the
// SSE channels. Views read this; the server owns the truth.

import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    // MARK: Connection

    var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: Self.urlKey) }
    }
    private(set) var isConnected = false
    private(set) var lastError: String?

    // MARK: Live state

    private(set) var stage: StageState?
    private(set) var pcoLive: PcoLiveDTO?
    private(set) var propresenter: ProPresenterStatusDTO?
    private(set) var transcript: [TranscriptLineDTO] = []

    private var sseTask: Task<Void, Never>?
    private let maxTranscript = 200
    private static let urlKey = "serverURLString"

    init() {
        self.serverURLString = UserDefaults.standard.string(forKey: Self.urlKey)
            ?? "http://stage-utility.local:8788"
    }

    // MARK: Derived

    var baseURL: URL? { URL(string: serverURLString) }
    var displays: [DisplayInfo] { stage?.displays ?? [] }
    func display(id: String) -> DisplayInfo? { displays.first { $0.id == id } }

    /// Resolved slots for a display, falling back to the primary set.
    func slots(for displayId: String) -> [Slot] {
        stage?.slotsByDisplay[displayId] ?? stage?.slots ?? []
    }

    // MARK: Lifecycle

    func connect() {
        guard let base = baseURL else { lastError = "Invalid server URL"; return }
        disconnect()

        let client = ServerClient(baseURL: base)
        Task {
            do {
                stage = try await client.getState()
                isConnected = true
                lastError = nil
            } catch {
                isConnected = false
                lastError = "Couldn’t reach \(base.absoluteString) — \(error.localizedDescription)"
                return
            }
            // Best-effort hydrate; SSE backfills if these endpoints are absent.
            propresenter = try? await client.getProPresenterStatus()
            pcoLive = try? await client.getPcoLive()
            if let backfill = try? await client.getTranscript() {
                transcript = Array(backfill.suffix(maxTranscript))
            }
        }

        let sse = SSEClient(url: base.appendingPathComponent("/api/events"))
        sseTask = Task {
            for await event in await sse.stream() {
                handle(event)
            }
        }
    }

    func disconnect() {
        sseTask?.cancel()
        sseTask = nil
    }

    // MARK: SSE handling

    private func handle(_ event: SSEClient.Event) {
        guard let data = event.data.data(using: .utf8) else { return }
        let dec = JSONDecoder()
        switch event.channel {
        case "stage:state-changed":
            if let s = try? dec.decode(StageState.self, from: data) {
                stage = s
                isConnected = true
            }
        case "pco:live":
            if let p = try? dec.decode(PcoLiveDTO.self, from: data) { pcoLive = p }
        case "propresenter:status":
            if let p = try? dec.decode(ProPresenterStatusDTO.self, from: data) { propresenter = p }
        case "prodcom:transcript":
            appendTranscript(from: data, decoder: dec)
        default:
            break
        }
    }

    /// The transcript channel may push a single line, an array, or a wrapper.
    private func appendTranscript(from data: Data, decoder: JSONDecoder) {
        if let line = try? decoder.decode(TranscriptLineDTO.self, from: data) {
            mergeTranscript([line]); return
        }
        if let arr = try? decoder.decode([TranscriptLineDTO].self, from: data) {
            mergeTranscript(arr); return
        }
        struct Wrapper: Decodable { let lines: [TranscriptLineDTO]?; let line: TranscriptLineDTO? }
        if let w = try? decoder.decode(Wrapper.self, from: data) {
            mergeTranscript(w.lines ?? [w.line].compactMap { $0 })
        }
    }

    private func mergeTranscript(_ incoming: [TranscriptLineDTO]) {
        for line in incoming {
            if let idx = transcript.firstIndex(where: { $0.id == line.id }) {
                transcript[idx] = line          // interim hypothesis → final revision
            } else {
                transcript.append(line)
            }
        }
        if transcript.count > maxTranscript {
            transcript.removeFirst(transcript.count - maxTranscript)
        }
    }
}
