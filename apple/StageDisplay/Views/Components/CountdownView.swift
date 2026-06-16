// CountdownView.swift — ticking PCO countdown. Green while counting down, red in
// overtime (matching PCO's timer).

import SwiftUI

struct CountdownView: View {
    let live: PcoLiveDTO?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = live.flatMap { Countdown.remaining($0, now: context.date) }
            VStack(spacing: 4) {
                if let label = live?.label, !label.isEmpty {
                    Text(label)
                        .font(.headline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(remaining.map(Countdown.format) ?? "—")
                    .font(.system(size: 64, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(timeColor(remaining))
            }
        }
    }

    private func timeColor(_ remaining: TimeInterval?) -> Color {
        guard let remaining else { return .secondary }
        return remaining < 0 ? .red : .green
    }
}
