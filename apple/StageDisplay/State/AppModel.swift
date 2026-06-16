// AppModel.swift — the single observable store. Polls the server (REST) on a
// 1s loop for all live state (StageState + PCO live + ProPresenter + transcript).
// Polling is simple and reliable; the server holds the truth.

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
    /// server − device clock offset, captured each time pcoLive is fetched (with a
    /// FRESH serverNow), so the countdown advances correctly between ticks.
    private(set) var pcoSkew: TimeInterval = 0
    private(set) var propresenter: ProPresenterStatusDTO?
    private(set) var transcript: [TranscriptLineDTO] = []

    private var pollTask: Task<Void, Never>?
    private let maxTranscript = 200
    private let pollIntervalNanos: UInt64 = 1_000_000_000   // 1s
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
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                let ok = await self?.refresh(client) ?? false
                if let self {
                    if ok {
                        self.isConnected = true
                        self.lastError = nil
                    } else if !self.isConnected {
                        self.lastError = "Couldn’t reach \(base.absoluteString)"
                    }
                }
                try? await Task.sleep(nanoseconds: self?.pollIntervalNanos ?? 1_000_000_000)
            }
        }
    }

    func disconnect() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// One poll pass. Returns true if the server was reachable (state fetched).
    private func refresh(_ client: ServerClient) async -> Bool {
        guard let state = try? await client.getState() else { return false }
        stage = state
        if let pp = try? await client.getProPresenterStatus() { propresenter = pp }
        if let live = try? await client.getPcoLive() { applyPcoLive(live) }
        if let lines = try? await client.getTranscript() {
            transcript = Array(lines.suffix(maxTranscript))
        }
        return true
    }

    /// Assign or clear a display's NDI source on the server; the next poll reflects it.
    func setNDISource(displayId: String, source: String?) {
        guard let base = baseURL else { return }
        let trimmed = source?.trimmingCharacters(in: .whitespaces)
        let value = (trimmed?.isEmpty ?? true) ? nil : trimmed
        let client = ServerClient(baseURL: base)
        Task { try? await client.setNDISource(displayId: displayId, source: value) }
    }

    // MARK: Helpers

    /// Set pcoLive and capture the clock skew (server − device now) with the fresh
    /// serverNow from this fetch.
    private func applyPcoLive(_ live: PcoLiveDTO) {
        pcoLive = live
        if let serverNow = Countdown.parseISO(live.serverNow) {
            pcoSkew = serverNow.timeIntervalSinceNow
        }
    }
}
