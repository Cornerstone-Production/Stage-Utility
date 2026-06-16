// KeepAwake.swift — stop the display sleeping while a stage view is up
// (appliance behaviour). iOS/tvOS use the idle timer; macOS holds a
// ProcessInfo activity token.

import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

final class ScreenWakeLock {
    #if os(macOS)
    private var token: NSObjectProtocol?
    func enable() {
        guard token == nil else { return }
        token = ProcessInfo.processInfo.beginActivity(
            options: [.idleDisplaySleepDisabled, .userInitiated],
            reason: "Stage display")
    }
    func disable() {
        if let token {
            ProcessInfo.processInfo.endActivity(token)
            self.token = nil
        }
    }
    #elseif canImport(UIKit)
    func enable() { UIApplication.shared.isIdleTimerDisabled = true }
    func disable() { UIApplication.shared.isIdleTimerDisabled = false }
    #else
    func enable() {}
    func disable() {}
    #endif
}

private struct KeepAwakeModifier: ViewModifier {
    @State private var lock = ScreenWakeLock()
    func body(content: Content) -> some View {
        content
            .onAppear { lock.enable() }
            .onDisappear { lock.disable() }
    }
}

extension View {
    func keepAwake() -> some View { modifier(KeepAwakeModifier()) }
}
