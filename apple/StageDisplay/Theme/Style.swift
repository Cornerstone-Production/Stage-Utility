// Style.swift — shared visual language matching the web displays: glass cards,
// accent colors, ProPresenter section chips, and the per-channel transcript color.

import SwiftUI

// MARK: - Palette (mirrors the web)

enum Palette {
    static let bg = Color(red: 0x08/255, green: 0x08/255, blue: 0x10/255)   // #080810
    static let green = Color(hex: "7fe3c4")!     // live timer value
    static let greenLabel = Color(hex: "5dcaa5")!
    static let amber = Color(hex: "f0c060")!     // "next" accents
    static let cardBG = Color.white.opacity(0.04)
    static let cardBorder = Color.white.opacity(0.08)
}

/// Deterministic per-channel transcript color (ports channel-color.ts).
func channelColor(_ channel: String?) -> Color {
    let palette = ["e6e6ea", "7fe3c4", "f0c060", "9db8ff", "f0a0c0", "b9e08a"]
    guard let channel, !channel.isEmpty else { return Color(hex: palette[0])! }
    var h: UInt32 = 0
    for u in channel.unicodeScalars { h = h &* 31 &+ u.value }
    return Color(hex: palette[Int(h % UInt32(palette.count))])!
}

func channelLabel(_ line: TranscriptLineDTO) -> String? {
    line.channelName ?? line.channel
}

// MARK: - Glass card (mirrors the web Tile/Cell)

enum CardAccent { case neutral, green, red, amber }

struct GlassCard<Content: View>: View {
    var label: String? = nil
    var accent: CardAccent = .neutral
    var alignment: Alignment = .center
    @ViewBuilder var content: Content

    var body: some View {
        let horizontal: HorizontalAlignment = alignment == .center ? .center : .leading
        VStack(alignment: horizontal, spacing: 8) {
            if let label {
                Text(label.uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1.2)
                    .foregroundStyle(labelColor)
                    .lineLimit(1)
            }
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
        .padding(16)
        .background(bgColor, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(borderColor, lineWidth: 1))
    }

    private var bgColor: Color {
        switch accent {
        case .neutral: Palette.cardBG
        case .green: Color(hex: "2dd496")!.opacity(0.08)
        case .red: Color.red.opacity(0.12)
        case .amber: Palette.amber.opacity(0.10)
        }
    }
    private var borderColor: Color {
        switch accent {
        case .neutral: Palette.cardBorder
        case .green: Color(hex: "2dd496")!.opacity(0.20)
        case .red: Color.red.opacity(0.35)
        case .amber: Palette.amber.opacity(0.30)
        }
    }
    private var labelColor: Color {
        switch accent {
        case .neutral: .white.opacity(0.40)
        case .green: Palette.greenLabel
        case .red: .red
        case .amber: Palette.amber
        }
    }
}

// MARK: - ProPresenter section chip

struct SectionChip: View {
    let section: ProSection?
    var small = false

    var body: some View {
        if let section {
            Text(section.name)
                .font(.system(size: small ? 12 : 15, weight: .medium))
                .padding(.horizontal, small ? 8 : 12)
                .padding(.vertical, small ? 2 : 5)
                .background(chipBackground, in: RoundedRectangle(cornerRadius: 7))
                .overlay(isBlack ? RoundedRectangle(cornerRadius: 7).strokeBorder(.white.opacity(0.2)) : nil)
                .foregroundStyle(chipText)
        }
    }

    private var isBlack: Bool { (section?.colorHex ?? "").lowercased().replacingOccurrences(of: "#", with: "") == "000000" }
    private var chipBackground: Color {
        guard let s = section else { return .gray }
        return isBlack ? Color.white.opacity(0.10) : (Color(hex: s.colorHex) ?? .gray)
    }
    private var chipText: Color {
        guard let hex = section?.colorHex, let n = UInt64(hex.replacingOccurrences(of: "#", with: ""), radix: 16), !isBlack else { return .white }
        let r = Double((n >> 16) & 0xFF), g = Double((n >> 8) & 0xFF), b = Double(n & 0xFF)
        let lum = (0.299*r + 0.587*g + 0.114*b) / 255
        return lum > 0.6 ? Color(hex: "11131a")! : .white
    }
}

// MARK: - PCO timer formatting helper

extension Countdown {
    /// Label + value + over-flag for the live timer, mirroring the web dashboard.
    static func display(_ live: PcoLiveDTO?, now: Date, skew: TimeInterval) -> (label: String, value: String, over: Bool)? {
        guard let live, let remaining = remaining(live, now: now, skew: skew) else { return nil }
        let over = remaining < 0
        let value = format(abs(remaining))
        let label: String
        switch live.mode {
        case .preservice: label = live.label ?? "Service start"
        case .item: label = live.label ?? "Current item"
        case .none: return nil
        }
        return (label, value, over)
    }
}
