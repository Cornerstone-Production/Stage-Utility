// StageDisplayApp.swift — app entry. One multiplatform scene; the kiosk/appliance
// behaviour (auto-launch a fixed display, hide chrome) is layered on in Phase 3.

import SwiftUI

@main
struct StageDisplayApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
