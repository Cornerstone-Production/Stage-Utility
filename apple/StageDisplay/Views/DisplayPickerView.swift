// DisplayPickerView.swift — choose which configured display to show. Long-press /
// context menu pins one as the appliance default (auto-opens on next launch).

import SwiftUI

struct DisplayPickerView: View {
    let model: AppModel
    @Binding var pinnedDisplayId: String
    @State private var showAbout = false

    var body: some View {
        List(model.displays) { display in
            NavigationLink(value: display.id) {
                row(display)
            }
            .contextMenu {
                Button {
                    pinnedDisplayId = display.id
                } label: {
                    Label("Pin as appliance", systemImage: "pin")
                }
            }
        }
        .navigationTitle(model.stage?.appName ?? "Displays")
        .navigationDestination(for: String.self) { id in
            DisplayContainerView(model: model, displayId: id, pinnedDisplayId: $pinnedDisplayId)
        }
        .toolbar {
            Button { showAbout = true } label: {
                Image(systemName: "info.circle")
            }
        }
        .sheet(isPresented: $showAbout) { AboutView() }
    }

    @ViewBuilder
    private func row(_ display: DisplayInfo) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon(for: display.resolvedKind))
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(display.name)
                Text(subtitle(display))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func subtitle(_ display: DisplayInfo) -> String {
        var s = display.resolvedKind.rawValue.capitalized
        if let ndi = display.ndiSource, !ndi.isEmpty { s += " · NDI: \(ndi)" }
        return s
    }

    private func icon(for kind: DisplayKind) -> String {
        switch kind {
        case .slots: "square.grid.2x2"
        case .dashboard: "rectangle.3.group"
        case .stage: "music.note.list"
        case .transcription: "captions.bubble"
        }
    }
}
