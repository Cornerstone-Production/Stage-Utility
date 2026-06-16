// RootView.swift — owns the AppModel, shows the connection screen until connected,
// then the display picker. Dark by default (stage use).

import SwiftUI

struct RootView: View {
    @State private var model = AppModel()

    var body: some View {
        NavigationStack {
            if model.isConnected {
                DisplayPickerView(model: model)
            } else {
                ServerConnectionView(model: model)
            }
        }
        .preferredColorScheme(.dark)
        .task { model.connect() }
    }
}
