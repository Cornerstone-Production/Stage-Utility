// AppBackground.swift — the dark base (#080810) used when a display has no NDI
// source. Matches the web client's background.

import SwiftUI

struct AppBackground: View {
    var body: some View {
        ZStack {
            Color(red: Double(0x08) / 255, green: Double(0x08) / 255, blue: Double(0x10) / 255)
            RadialGradient(
                colors: [Color.white.opacity(0.06), .clear],
                center: .top, startRadius: 0, endRadius: 700)
        }
        .ignoresSafeArea()
    }
}
