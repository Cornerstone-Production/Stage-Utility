// ServerConnectionView.swift — enter the Stage Utility server URL. A control
// surface, so it leans into Liquid Glass (.glassProminent button).

import SwiftUI

struct ServerConnectionView: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "display")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("Connect to Stage Utility")
                .font(.title2).bold()

            TextField("http://host:8788", text: $model.serverURLString)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 420)
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                #endif

            Button("Connect") { model.connect() }
                .buttonStyle(.glassProminent)

            if let error = model.lastError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppBackground())
    }
}
