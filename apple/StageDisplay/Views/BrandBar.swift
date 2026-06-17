// BrandBar.swift — the slim top bar shown on every display: app name · display
// name, an optional back button, and a settings gear. Mirrors the web brand bar
// (the gear replaces the web's QR→settings link).

import SwiftUI

struct BrandBar: View {
    let appName: String
    let displayName: String?
    var showBack: Bool
    var onBack: () -> Void
    var onSettings: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            if showBack {
                Button(action: onBack) {
                    Image(systemName: "chevron.backward").font(.headline)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white.opacity(0.7))
            }
            Text(appName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white.opacity(0.8))
            if let displayName {
                Rectangle().fill(.white.opacity(0.15)).frame(width: 1, height: 14)
                Text(displayName)
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.4))
                    .lineLimit(1)
            }
            Spacer()
            Button(action: onSettings) {
                Image(systemName: "gearshape").font(.title3)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white.opacity(0.7))
        }
        .padding(.horizontal, 14)
        .frame(height: 40)
        .background(.black.opacity(0.5))
        .overlay(alignment: .bottom) {
            Rectangle().fill(.white.opacity(0.09)).frame(height: 1)
        }
    }
}
