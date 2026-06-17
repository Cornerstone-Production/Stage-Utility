// AboutView.swift — app info + the NDI attribution the SDK terms require ("link
// to ndi.video close to where NDI is used").

import SwiftUI

struct AboutView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "display")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text("Stage Display")
                .font(.title2).bold()
            Text("Version \(appVersion)")
                .foregroundStyle(.secondary)

            Divider().frame(maxWidth: 320)

            VStack(spacing: 6) {
                Text("Powered by NDI®").font(.headline)
                Link("ndi.video", destination: URL(string: "https://ndi.video")!)
                Text("NDI® is a registered trademark of Vizrt Group.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(40)
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        return "\(short) (\(build))"
    }
}
