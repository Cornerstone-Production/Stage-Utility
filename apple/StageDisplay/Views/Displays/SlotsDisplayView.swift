// SlotsDisplayView.swift — the channel/slot grid (RF, battery, name). Card grid
// that scrolls when it overflows; mirrors the web slots display.

import SwiftUI

struct SlotsDisplayView: View {
    let model: AppModel
    let displayId: String

    private let columns = [GridItem(.adaptive(minimum: 160), spacing: 12)]

    var body: some View {
        let slots = model.slots(for: displayId).sorted { $0.order < $1.order }
        ScrollView {
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(slots) { slot in
                    SlotCard(slot: slot)
                }
            }
            .padding(16)
        }
    }
}

private struct SlotCard: View {
    let slot: Slot

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(slot.channel)
                    .font(.caption).monospaced()
                    .foregroundStyle(.secondary)
                Spacer()
                Circle().fill(statusColor).frame(width: 10, height: 10)
            }
            Text(slot.displayName ?? "—")
                .font(.headline)
                .lineLimit(1)
            HStack(spacing: 12) {
                if let rf = slot.device.rf {
                    Label("\(Int(rf))", systemImage: "antenna.radiowaves.left.and.right")
                }
                if let battery = slot.device.battery {
                    Label("\(Int(battery))%", systemImage: "battery.100")
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
    }

    private var statusColor: Color {
        switch slot.device.status {
        case .ok: .green
        case .warn: .yellow
        case .error: .red
        case .none: .gray
        }
    }
}
