// DisplayContainerView.swift — composites the NDI video layer (or the dark
// background) behind the selected display kind's overlays. A long-press reveals
// an appliance control bar (pin/unpin, About).

import SwiftUI

struct DisplayContainerView: View {
    let model: AppModel
    let displayId: String
    @Binding var pinnedDisplayId: String

    @State private var showControls = false
    @State private var showAbout = false

    var body: some View {
        let display = model.display(id: displayId)
        ZStack {
            if let source = display?.ndiSource, !source.isEmpty {
                NDIVideoLayer(sourceName: source).ignoresSafeArea()
            } else {
                AppBackground()
            }

            content(for: display?.resolvedKind ?? .slots)

            if showControls {
                controlBar(display)
            }
        }
        .contentShape(Rectangle())
        .onLongPressGesture(minimumDuration: 0.6) {
            withAnimation { showControls.toggle() }
        }
        .sheet(isPresented: $showAbout) { AboutView() }
        .navigationTitle(display?.name ?? "Display")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    @ViewBuilder
    private func controlBar(_ display: DisplayInfo?) -> some View {
        VStack {
            HStack(spacing: 12) {
                Text(display?.name ?? "Display").font(.headline)
                Spacer()
                if pinnedDisplayId == displayId {
                    Button("Exit appliance") {
                        pinnedDisplayId = ""
                        showControls = false
                    }
                } else {
                    Button("Pin as appliance") {
                        pinnedDisplayId = displayId
                        showControls = false
                    }
                }
                Button("About") { showAbout = true }
                Button("Hide") { withAnimation { showControls = false } }
            }
            .padding()
            .controlGlass(in: RoundedRectangle(cornerRadius: 16))
            .padding()
            Spacer()
        }
        .transition(.move(edge: .top).combined(with: .opacity))
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
