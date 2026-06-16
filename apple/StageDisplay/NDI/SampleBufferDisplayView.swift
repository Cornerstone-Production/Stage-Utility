// SampleBufferDisplayView.swift — hosts an AVSampleBufferDisplayLayer and feeds
// it CMSampleBuffers from an NDI receiver. This file has no NDI dependency (it
// uses the NDIReceiving abstraction), so it always compiles.

import SwiftUI
import AVFoundation

#if os(macOS)
import AppKit
typealias PlatformViewRepresentable = NSViewRepresentable
#else
import UIKit
typealias PlatformViewRepresentable = UIViewRepresentable
#endif

/// SwiftUI view that renders a live NDI source full-bleed.
struct NDIVideoView: PlatformViewRepresentable {
    let sourceName: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    #if os(macOS)
    func makeNSView(context: Context) -> SampleBufferHostView { makeHost(context) }
    func updateNSView(_ view: SampleBufferHostView, context: Context) {}
    static func dismantleNSView(_ view: SampleBufferHostView, coordinator: Coordinator) {
        coordinator.stop()
    }
    #else
    func makeUIView(context: Context) -> SampleBufferHostView { makeHost(context) }
    func updateUIView(_ view: SampleBufferHostView, context: Context) {}
    static func dismantleUIView(_ view: SampleBufferHostView, coordinator: Coordinator) {
        coordinator.stop()
    }
    #endif

    private func makeHost(_ context: Context) -> SampleBufferHostView {
        let view = SampleBufferHostView()
        context.coordinator.start(sourceName: sourceName, layer: view.displayLayer)
        return view
    }

    final class Coordinator {
        private var receiver: NDIReceiving?

        func start(sourceName: String, layer: AVSampleBufferDisplayLayer) {
            let receiver = makeNDIReceiver(sourceName: sourceName)
            self.receiver = receiver
            let renderer = layer.sampleBufferRenderer
            receiver.start { sampleBuffer in
                // Frames arrive on the NDI thread; enqueue on main.
                DispatchQueue.main.async {
                    if renderer.status == .failed { renderer.flush() }
                    renderer.enqueue(sampleBuffer)
                }
            }
        }

        func stop() {
            receiver?.stop()
            receiver = nil
        }
    }
}

// MARK: - Layer-backed host view

#if os(macOS)
final class SampleBufferHostView: NSView {
    let displayLayer = AVSampleBufferDisplayLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        displayLayer.videoGravity = .resizeAspectFill
        layer = displayLayer
        wantsLayer = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        displayLayer.frame = bounds
    }
}
#else
final class SampleBufferHostView: UIView {
    override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
    var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }

    override init(frame: CGRect) {
        super.init(frame: frame)
        displayLayer.videoGravity = .resizeAspectFill
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}
#endif
