// DisplayPickerView.swift — choose which configured display to show on this
// device. (Phase 3 lets a tvOS appliance auto-open a pinned display instead.)

import SwiftUI

struct DisplayPickerView: View {
    let model: AppModel

    var body: some View {
        List(model.displays) { display in
            NavigationLink(value: display.id) {
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
        }
        .navigationTitle(model.stage?.appName ?? "Displays")
        .navigationDestination(for: String.self) { id in
            DisplayContainerView(model: model, displayId: id)
        }
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
