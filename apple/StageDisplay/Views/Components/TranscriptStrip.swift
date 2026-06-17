// TranscriptStrip.swift — the latest transcript line as a glass pill with a
// channel-colored speaker label. Mirrors the web dashboard/stage strip; renders
// nothing when there are no lines.

import SwiftUI

struct TranscriptStrip: View {
    let lines: [TranscriptLineDTO]

    var body: some View {
        if let last = lines.last {
            HStack(spacing: 12) {
                Text((channelLabel(last) ?? "Transcript").uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1.4)
                    .foregroundStyle(channelLabel(last) != nil ? channelColor(last.channel) : .white.opacity(0.4))
                    .lineLimit(1)
                    .layoutPriority(1)
                Text(last.text)
                    .font(.title3)
                    .foregroundStyle(last.isFinal ? .white.opacity(0.85) : .white.opacity(0.5))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .background(Palette.cardBG, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.cardBorder, lineWidth: 1))
        }
    }
}
