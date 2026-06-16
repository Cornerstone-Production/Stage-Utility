// NDIBrowser.swift — discover NDI source names on the LAN so the in-app picker
// can offer them. Returns [] without the SDK linked.

import Foundation
#if canImport(NDI)
import NDI
#endif

enum NDIBrowser {
    /// Names of NDI sources currently visible on the network.
    static func discover(timeoutMs: UInt32 = 1500) async -> [String] {
        #if canImport(NDI)
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                guard NDIlib_initialize(), let find = NDIlib_find_create_v2(nil) else {
                    continuation.resume(returning: [])
                    return
                }
                _ = NDIlib_find_wait_for_sources(find, timeoutMs)
                var count: UInt32 = 0
                var names: [String] = []
                if let list = NDIlib_find_get_current_sources(find, &count) {
                    for i in 0..<Int(count) {
                        if let p = list[i].p_ndi_name { names.append(String(cString: p)) }
                    }
                }
                NDIlib_find_destroy(find)   // leave the library initialized for any active receiver
                continuation.resume(returning: names)
            }
        }
        #else
        []
        #endif
    }
}
