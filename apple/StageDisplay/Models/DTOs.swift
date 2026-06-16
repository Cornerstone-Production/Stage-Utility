// DTOs.swift — Swift Codable mirrors of the server's wire contract.
//
// CANONICAL SOURCE: ../../../main/types/stage.ts ("frontend mirrors these shapes
// exactly"). When a DTO changes there, change it here in the same PR. Extra JSON
// keys are ignored by Codable, so adding optional server fields is non-breaking.

import Foundation

// MARK: - Displays

enum DisplayKind: String, Codable, CaseIterable, Sendable {
    case slots, dashboard, stage, transcription
}

struct DisplayInfo: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var kind: DisplayKind?
    /// NDI source name to show behind this display (native-only). nil = none.
    var ndiSource: String?

    /// Defaults to `.slots` when the server omits `kind` (back-compat).
    var resolvedKind: DisplayKind { kind ?? .slots }
}

// MARK: - ProPresenter

struct ProSection: Codable, Hashable, Sendable {
    let name: String
    let colorHex: String   // "#rrggbb"
}

struct ProTimer: Codable, Hashable, Sendable {
    let name: String
    let time: String       // e.g. "00:03:00"
    let state: String
}

struct ProPresenterStatusDTO: Codable, Hashable, Sendable {
    let connected: Bool
    let currentItem: String?
    let nextItem: String?
    let slideIndex: Int?
    let slideCount: Int?
    let slidesRemaining: Int?
    let currentSlideText: String?
    let nextSlideText: String?
    let currentNotes: String?
    let nextNotes: String?
    let currentSection: ProSection?
    let nextSection: ProSection?
    let nextArrangementSection: ProSection?
    let currentServiceItem: String?
    let nextServiceItem: String?
    let timers: [ProTimer]
    let slidePreviewKey: String?
}

// MARK: - PCO Live countdown

struct PcoLiveDTO: Codable, Hashable, Sendable {
    enum Mode: String, Codable, Sendable { case item, preservice, none }
    let mode: Mode
    let label: String?
    let lengthSec: Double?
    let liveStartAt: String?   // ISO — countdown anchor (item mode)
    let targetAt: String?      // ISO — count-down-to (preservice mode)
    let serverNow: String      // ISO — server clock at send time (skew correction)
}

// MARK: - Transcript

struct TranscriptLineDTO: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let channel: String?
    let channelName: String?
    let text: String
    let isFinal: Bool
    let at: String             // ISO
}

// MARK: - Slots

struct SlotDevice: Codable, Hashable, Sendable {
    enum Status: String, Codable, Sendable { case none, ok, warn, error }
    let status: Status
    let rf: Double?
    let battery: Double?
    let freq: String?
    let audioLevel: Double?
}

/// Discriminated union on `kind` (mirrors SlotLink in stage.ts).
enum SlotLink: Codable, Hashable, Sendable {
    case pcoPerson(personId: String)
    case pcoPosition(teamPositionName: String, notesStartsWith: String?)
    case staticLabel(label: String, color: String)
    case empty

    private enum Keys: String, CodingKey {
        case kind, matchBy, personId, teamPositionName, notesStartsWith, label, color
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "pco":
            if try c.decode(String.self, forKey: .matchBy) == "person" {
                self = .pcoPerson(personId: try c.decode(String.self, forKey: .personId))
            } else {
                self = .pcoPosition(
                    teamPositionName: try c.decode(String.self, forKey: .teamPositionName),
                    notesStartsWith: try c.decodeIfPresent(String.self, forKey: .notesStartsWith))
            }
        case "static":
            self = .staticLabel(
                label: try c.decode(String.self, forKey: .label),
                color: try c.decode(String.self, forKey: .color))
        default:
            self = .empty
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .pcoPerson(let personId):
            try c.encode("pco", forKey: .kind)
            try c.encode("person", forKey: .matchBy)
            try c.encode(personId, forKey: .personId)
        case .pcoPosition(let name, let notes):
            try c.encode("pco", forKey: .kind)
            try c.encode("position", forKey: .matchBy)
            try c.encode(name, forKey: .teamPositionName)
            try c.encodeIfPresent(notes, forKey: .notesStartsWith)
        case .staticLabel(let label, let color):
            try c.encode("static", forKey: .kind)
            try c.encode(label, forKey: .label)
            try c.encode(color, forKey: .color)
        case .empty:
            try c.encode("empty", forKey: .kind)
        }
    }
}

struct Slot: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let channel: String
    let order: Int
    let link: SlotLink
    var displayName: String?
    var photoUrl: String?
    var device: SlotDevice
    var stackWithPrevious: Bool?
    // `deviceBinding` is control-plane only and intentionally not decoded here.
}

// MARK: - Top-level state

struct StageState: Codable, Hashable, Sendable {
    let serviceTypeId: String?
    let serviceTypeName: String?
    let planMode: String
    let planId: String?
    let planTitle: String?
    let planSeriesTitle: String?
    let slots: [Slot]
    let slotsByDisplay: [String: [Slot]]
    let displays: [DisplayInfo]
    let pcoConfigured: Bool
    let lastRefreshedAt: String?
    let remoteUrl: String?
    let showQr: Bool
    let allowedServiceTypeIds: [String]
    let appName: String
    let appLogo: String?
    let appLogoMonochrome: Bool
    let emptySlotLogo: String?
}
