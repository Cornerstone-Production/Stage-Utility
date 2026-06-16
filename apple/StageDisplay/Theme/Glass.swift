// Glass.swift — Liquid Glass helpers.
//
// HIG: glass belongs on the FUNCTIONAL layer (controls, chrome, transient
// overlays), not the live content layer. Use `.controlGlass()` for pills,
// toolbars, and buttons — keep primary slide/lyric text solid and high-contrast
// so it stays legible over NDI video on a wall monitor.

import SwiftUI

extension View {
    /// Liquid Glass on the 26+ SDK; a material fallback below it (so the project
    /// can lower its deployment target without breaking).
    @ViewBuilder
    func controlGlass(in shape: some Shape) -> some View {
        if #available(iOS 26.0, tvOS 26.0, macOS 26.0, *) {
            self.glassEffect(.regular, in: shape)
        } else {
            self.background(.ultraThinMaterial, in: shape)
        }
    }
}
