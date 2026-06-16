// NDIReceiver.swift — the seam between the app and the NDI SDK.
//
// The real receiver (NDISDKReceiver) is compiled in ONLY when the NDI SDK is
// present as a Clang module named `NDI` (see apple/NDISupport/module.modulemap
// and the README). Without it, `makeNDIReceiver` returns a no-op and the UI
// falls back to the placeholder — so the project always builds, and "lights up"
// the moment you add the licensed SDK.

import Foundation
import CoreMedia

/// Pulls frames for one NDI source and hands them back as CMSampleBuffers.
protocol NDIReceiving: AnyObject {
    /// Begin receiving. `onFrame` is called from a background thread for each
    /// decoded video frame; the caller is responsible for hopping to the layer's
    /// thread before enqueuing.
    func start(onFrame: @escaping (CMSampleBuffer) -> Void)
    func stop()
}

/// True when the NDI SDK module is linked in. Drives the UI fallback.
enum NDISupport {
    static var isAvailable: Bool {
        #if canImport(NDI)
        return true
        #else
        return false
        #endif
    }
}

/// Factory — real receiver if the SDK is present, no-op otherwise.
func makeNDIReceiver(sourceName: String) -> NDIReceiving {
    #if canImport(NDI)
    return NDISDKReceiver(sourceName: sourceName)
    #else
    return NoopNDIReceiver()
    #endif
}

/// Used when the SDK isn't linked — produces no frames.
final class NoopNDIReceiver: NDIReceiving {
    func start(onFrame: @escaping (CMSampleBuffer) -> Void) {}
    func stop() {}
}
