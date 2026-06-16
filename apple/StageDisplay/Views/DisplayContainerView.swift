// DisplayContainerView.swift — composites the NDI video layer (or the dark
// background) behind the selected display kind's overlays.

import SwiftUI

struct DisplayContainerView: View {
    let model: AppModel
    let displayId: String

    var body: some View {
        let display = model.display(id: displayId)
        ZStack {
            if let source = display?.ndiSource, !source.isEmpty {
                NDIVideoLayer(sourceName: source).ignoresSafeArea()
            } else {
                AppBackground()
            }
            content(for: display?.resolvedKind ?? .slots)
        }
        .navigationTitle(display?.name ?? "Display")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
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
