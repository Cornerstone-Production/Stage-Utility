// NDIVideoLayer.swift — the video surface behind a display's data overlays.
//
// When the NDI SDK is linked (NDISupport.isAvailable) and the display has a
// source, this renders the live feed via NDIVideoView (AVSampleBufferDisplayLayer
// fed by NDISDKReceiver). Otherwise it shows a placeholder describing the wiring
// — so the app is useful and self-explanatory before the SDK is added.

import SwiftUI

struct NDIVideoLayer: View {
    let sourceName: String?

    var body: some View {
        ZStack {
            Color.black
            if let name = sourceName, !name.isEmpty {
                if NDISupport.isAvailable {
                    NDIVideoView(sourceName: name)
                } else {
                    placeholder(name)
                }
            }
        }
    }

    private func placeholder(_ name: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("NDI ▸ \(name)")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("Add the NDI SDK module to enable video (see apple/README)")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}
