// DisplaySettingsSheet.swift — opened from the brand-bar gear. The discoverable
// home for NDI assignment, appliance pinning, About, and the server connection.

import SwiftUI

struct DisplaySettingsSheet: View {
    let model: AppModel
    let displayId: String
    @Binding var pinnedDisplayId: String
    @Environment(\.dismiss) private var dismiss

    @State private var ndiField = ""
    @State private var discovered: [String] = []
    @State private var scanning = false

    var body: some View {
        NavigationStack {
            Form {
                Section("NDI video source") {
                    TextField("Source name (e.g. STUDIO (Program))", text: $ndiField)
                        #if os(iOS)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        #endif
                    HStack {
                        Button("Set") { model.setNDISource(displayId: displayId, source: ndiField) }
                        Spacer()
                        Button("Clear", role: .destructive) {
                            ndiField = ""
                            model.setNDISource(displayId: displayId, source: nil)
                        }
                    }
                    if NDISupport.isAvailable {
                        Button(scanning ? "Scanning…" : "Scan network for sources") { scan() }
                            .disabled(scanning)
                        ForEach(discovered, id: \.self) { name in
                            Button {
                                ndiField = name
                                model.setNDISource(displayId: displayId, source: name)
                            } label: {
                                Label(name, systemImage: "dot.radiowaves.left.and.right")
                            }
                        }
                    } else {
                        Text("Link the NDI SDK to scan for sources (see apple/README). You can still type a name now.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }

                Section("Appliance") {
                    if pinnedDisplayId == displayId {
                        Button("Exit appliance mode") { pinnedDisplayId = ""; dismiss() }
                    } else {
                        Button("Pin as appliance (auto-open on launch)") {
                            pinnedDisplayId = displayId; dismiss()
                        }
                    }
                }

                Section("Server") {
                    LabeledContent("Connected to", value: model.serverURLString)
                    Button("Disconnect / change server", role: .destructive) {
                        model.disconnect()
                        pinnedDisplayId = ""
                        dismiss()
                    }
                }

                Section {
                    NavigationLink { AboutView() } label: { Label("About", systemImage: "info.circle") }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                Button("Done") { dismiss() }
            }
        }
        .onAppear { ndiField = model.display(id: displayId)?.ndiSource ?? "" }
    }

    private func scan() {
        scanning = true
        Task {
            let sources = await NDIBrowser.discover()
            await MainActor.run { discovered = sources; scanning = false }
        }
    }
}
