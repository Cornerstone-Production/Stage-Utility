// NDISDKReceiver.swift — the real NDI receive pipeline.
//
// Compiled in ONLY when the NDI SDK is linked as a Clang module named `NDI`
// (see apple/NDISupport/module.modulemap + README). Without it this whole file
// is empty, so the project builds with the placeholder.
//
// Pipeline: NDIlib_find (discover by name) → NDIlib_recv (pull frames) →
// CVPixelBuffer (zero-ish copy) → CMSampleBuffer (display-immediately) → caller
// enqueues into AVSampleBufferDisplayLayer (which uses VideoToolbox under the
// hood for compressed formats).
//
// NOTE: the NDI C API is stable across SDK 5/6, but confirm the exact enum/field
// spellings against the headers you install (e.g. NDIlib_FourCC_type_UYVY vs the
// older NDIlib_FourCC_video_type_UYVY alias).

#if canImport(NDI)

import Foundation
import CoreMedia
import CoreVideo
import NDI

final class NDISDKReceiver: NDIReceiving {
    private let sourceName: String
    private var recv: NDIlib_recv_instance_t?
    private var thread: Thread?
    private var running = false
    private var onFrame: ((CMSampleBuffer) -> Void)?

    init(sourceName: String) {
        self.sourceName = sourceName
    }

    func start(onFrame: @escaping (CMSampleBuffer) -> Void) {
        guard NDIlib_initialize() else { return }
        self.onFrame = onFrame
        running = true
        let thread = Thread { [weak self] in self?.runLoop() }
        thread.name = "ndi.recv.\(sourceName)"
        thread.qualityOfService = .userInteractive
        thread.start()
        self.thread = thread
    }

    func stop() {
        running = false
        if let recv {
            NDIlib_recv_destroy(recv)
            self.recv = nil
        }
        NDIlib_destroy()
    }

    // MARK: - Receive loop (background thread)

    private func runLoop() {
        guard let find = NDIlib_find_create_v2(nil) else { return }
        defer { NDIlib_find_destroy(find) }

        // 1) Discover the named source on the LAN (mDNS).
        var source: NDIlib_source_t?
        while running && source == nil {
            _ = NDIlib_find_wait_for_sources(find, 2000)
            var count: UInt32 = 0
            if let list = NDIlib_find_get_current_sources(find, &count) {
                for i in 0..<Int(count) {
                    let candidate = list[i]
                    if let namePtr = candidate.p_ndi_name,
                       String(cString: namePtr) == sourceName {
                        source = candidate
                        break
                    }
                }
            }
        }
        guard running, let src = source else { return }

        // 2) Connect a receiver. Request UYVY for opaque sources and BGRA for
        //    sources with alpha — both are handled in makeSampleBuffer below.
        var settings = NDIlib_recv_create_v3_t()
        settings.source_to_connect_to = src
        settings.color_format = NDIlib_recv_color_format_UYVY_BGRA
        settings.bandwidth = NDIlib_recv_bandwidth_highest
        settings.allow_video_fields = false
        guard let recv = NDIlib_recv_create_v3(&settings) else { return }
        self.recv = recv

        // 3) Pump frames until stopped.
        while running {
            var video = NDIlib_video_frame_v2_t()
            let type = NDIlib_recv_capture_v2(recv, &video, nil, nil, 1000)
            switch type {
            case NDIlib_frame_type_video:
                if let sampleBuffer = makeSampleBuffer(from: video) {
                    onFrame?(sampleBuffer)
                }
                NDIlib_recv_free_video_v2(recv, &video)
            default:
                break // none/audio/metadata/error — keep waiting
            }
        }
    }

    // MARK: - Frame conversion

    private func makeSampleBuffer(from frame: NDIlib_video_frame_v2_t) -> CMSampleBuffer? {
        let width = Int(frame.xres)
        let height = Int(frame.yres)
        guard width > 0, height > 0, let data = frame.p_data else { return nil }
        let srcStride = Int(frame.line_stride_in_bytes)

        // frame.FourCC is NDIlib_FourCC_video_type_e.
        let pixelFormat: OSType
        switch frame.FourCC {
        case NDIlib_FourCC_video_type_UYVY:
            pixelFormat = kCVPixelFormatType_422YpCbCr8           // '2vuy'
        case NDIlib_FourCC_video_type_BGRA, NDIlib_FourCC_video_type_BGRX:
            pixelFormat = kCVPixelFormatType_32BGRA
        case NDIlib_FourCC_video_type_RGBA, NDIlib_FourCC_video_type_RGBX:
            pixelFormat = kCVPixelFormatType_32RGBA
        default:
            return nil // planar/compressed formats need a dedicated path
        }

        var pixelBuffer: CVPixelBuffer?
        let attrs: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, pixelFormat,
                                  attrs as CFDictionary, &pixelBuffer) == kCVReturnSuccess,
              let pb = pixelBuffer else { return nil }

        CVPixelBufferLockBaseAddress(pb, [])
        if let dest = CVPixelBufferGetBaseAddress(pb) {
            let destStride = CVPixelBufferGetBytesPerRow(pb)
            let rowBytes = min(srcStride, destStride)
            for row in 0..<height {
                memcpy(dest.advanced(by: row * destStride),
                       data.advanced(by: row * srcStride),
                       rowBytes)
            }
        }
        CVPixelBufferUnlockBaseAddress(pb, [])

        var formatDescription: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(
                allocator: kCFAllocatorDefault, imageBuffer: pb,
                formatDescriptionOut: &formatDescription) == noErr,
              let format = formatDescription else { return nil }

        var timing = CMSampleTimingInfo(duration: .invalid,
                                        presentationTimeStamp: .invalid,
                                        decodeTimeStamp: .invalid)
        var sampleBuffer: CMSampleBuffer?
        guard CMSampleBufferCreateForImageBuffer(
                allocator: kCFAllocatorDefault, imageBuffer: pb, dataReady: true,
                makeDataReadyCallback: nil, refcon: nil, formatDescription: format,
                sampleTiming: &timing, sampleBufferOut: &sampleBuffer) == noErr,
              let sb = sampleBuffer else { return nil }

        // No timebase on the layer → ask it to display each frame immediately.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0 {
            let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0),
                                     to: CFMutableDictionary.self)
            CFDictionarySetValue(
                dict,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        return sb
    }
}

#endif
