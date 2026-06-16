// TranscriptStrip.swift — the latest transcript line with a speaker/channel pill,
// shown across the dashboard/stage displays.

import SwiftUI

struct TranscriptStrip: View {
    let lines: [TranscriptLineDTO]

    var body: some View {
        let last = lines.last
        HStack(spacing: 8) {
            if let name = last?.channelName, !name.isEmpty {
                Text(name.uppercased())
                    .font(.caption).bold()
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .controlGlass(in: Capsule())
            }
            Text(last?.text ?? "…")
                .font(.title3)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 16))
    }
}
