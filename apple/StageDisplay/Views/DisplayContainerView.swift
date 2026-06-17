// DisplayContainerView.swift — a display: brand bar on top, then the NDI video
// layer (or dark background) with the kind's overlays composited above it. The
// gear opens DisplaySettingsSheet (NDI, appliance, server, about).

import SwiftUI

struct DisplayContainerView: View {
    let model: AppModel
    let displayId: String
    @Binding var pinnedDisplayId: String

    @Environment(\.dismiss) private var dismiss
    @State private var showSettings = false

    var body: some View {
        let display = model.display(id: displayId)
        VStack(spacing: 0) {
            BrandBar(
                appName: model.stage?.appName ?? "Stage Display",
                displayName: display?.name,
                showBack: pinnedDisplayId != displayId,
                onBack: { dismiss() },
                onSettings: { showSettings = true })

            ZStack {
                if let source = display?.ndiSource, !source.isEmpty {
                    NDIVideoLayer(sourceName: source)
                } else {
                    Palette.bg
                }
                content(for: display?.resolvedKind ?? .slots)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Palette.bg)
        .sheet(isPresented: $showSettings) {
            DisplaySettingsSheet(model: model, displayId: displayId, pinnedDisplayId: $pinnedDisplayId)
        }
        #if !os(macOS)
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        #endif
    }

    @ViewBuilder
    private func content(for kind: DisplayKind) -> some View {
        switch kind {
        case .slots:         SlotsDisplayView(model: model, displayId: displayId)
        case .dashboard:     DashboardDisplayView(model: model)
        case .stage:         StageConfidenceView(model: model)
        case .transcription: TranscriptionDisplayView(model: model)
        }
    }
}
