// DisplayContainerView.swift — composites the NDI video layer (or the dark
// background) behind the selected display kind's overlays. A long-press reveals
// an appliance control bar: pin/unpin, About, and an in-app NDI source picker.

import SwiftUI

struct DisplayContainerView: View {
    let model: AppModel
    let displayId: String
    @Binding var pinnedDisplayId: String

    @State private var showControls = false
    @State private var showAbout = false
    @State private var ndiField = ""
    @State private var discovered: [String] = []
    @State private var scanning = false

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
                controlBar(display).transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .contentShape(Rectangle())
        .onLongPressGesture(minimumDuration: 0.6) {
            ndiField = display?.ndiSource ?? ""
            withAnimation { showControls.toggle() }
        }
        .sheet(isPresented: $showAbout) { AboutView() }
        .navigationTitle(display?.name ?? "Display")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    // MARK: Appliance control bar

    @ViewBuilder
    private func controlBar(_ display: DisplayInfo?) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Text(display?.name ?? "Display").font(.headline)
                Spacer()
                if pinnedDisplayId == displayId {
                    Button("Exit appliance") { pinnedDisplayId = ""; showControls = false }
                } else {
                    Button("Pin as appliance") { pinnedDisplayId = displayId; showControls = false }
                }
                Button("About") { showAbout = true }
                Button("Hide") { withAnimation { showControls = false } }
            }

            Divider()

            // In-app NDI source assignment (writes back to the server).
            Text("NDI SOURCE").font(.system(size: 11, weight: .semibold)).tracking(1.2).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                TextField("Source name", text: $ndiField)
                    .textFieldStyle(.roundedBorder)
                    #if os(iOS)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    #endif
                Button("Set") { model.setNDISource(displayId: displayId, source: ndiField) }
                Button("Clear") { ndiField = ""; model.setNDISource(displayId: displayId, source: nil) }
                if NDISupport.isAvailable {
                    Button(scanning ? "Scanning…" : "Scan") { scan() }.disabled(scanning)
                }
            }
            if !discovered.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(discovered, id: \.self) { name in
                            Button(name) {
                                ndiField = name
                                model.setNDISource(displayId: displayId, source: name)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            } else if !NDISupport.isAvailable {
                Text("Add the NDI SDK to scan for sources (see apple/README). You can still type a name and it'll show on a device that has NDI.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .controlGlass(in: RoundedRectangle(cornerRadius: 16))
        .padding(16)
        .frame(maxWidth: 720, maxHeight: .infinity, alignment: .top)
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private func scan() {
        scanning = true
        Task {
            let sources = await NDIBrowser.discover()
            await MainActor.run { discovered = sources; scanning = false }
        }
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
