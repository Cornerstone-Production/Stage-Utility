// NDIVideoLayer.swift — the video surface behind a display's data overlays.
//
// PHASE 1 (now): a placeholder so the composite (video behind, overlays on top)
// is already wired into every display view.
//
// PHASE 2 (NDI): replace the body with a platform view wrapping an
// AVSampleBufferDisplayLayer. The intended pipeline:
//   1. NDIlib_find_*           → discover sources on the LAN by name
//   2. match `sourceName`, NDIlib_recv_* → pull frames
//   3. VideoToolbox            → hardware-decode H.264/H.265 (or SDK decode)
//   4. AVSampleBufferDisplayLayer.enqueue(CMSampleBuffer) → render
// Wrap that layer in a UIViewRepresentable (iOS/tvOS) / NSViewRepresentable
// (macOS); keep this SwiftUI surface so callers don't change.

import SwiftUI

struct NDIVideoLayer: View {
    let sourceName: String?

    var body: some View {
        ZStack {
            Color.black
            if let name = sourceName, !name.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text("NDI ▸ \(name)")
                        .font(.headline)
                        .foregroundStyle(.secondary)
                    Text("Video renders here in Phase 2")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }
}
