// RootView.swift — owns the AppModel and routes:
//   not connected   → ServerConnectionView
//   pinned display   → DisplayContainerView directly (appliance mode, no chrome)
//   otherwise        → DisplayPickerView (in a NavigationStack)
// Keeps the screen awake and reconnects when the scene becomes active.

import SwiftUI

struct RootView: View {
    @State private var model = AppModel()
    @AppStorage("pinnedDisplayId") private var pinnedDisplayId = ""
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if !model.isConnected {
                ServerConnectionView(model: model)
            } else if !pinnedDisplayId.isEmpty, model.display(id: pinnedDisplayId) != nil {
                DisplayContainerView(model: model,
                                     displayId: pinnedDisplayId,
                                     pinnedDisplayId: $pinnedDisplayId)
            } else {
                NavigationStack {
                    DisplayPickerView(model: model, pinnedDisplayId: $pinnedDisplayId)
                }
            }
        }
        .preferredColorScheme(.dark)
        .keepAwake()
        .task { model.connect() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.connect() }
        }
    }
}
