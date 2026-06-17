// TranscriptionDisplayView.swift — full-screen captions, each line tinted by its
// channel color with a small speaker label; interim lines dimmed. Auto-scrolls to
// the newest line. Mirrors the web transcription display.

import SwiftUI

struct TranscriptionDisplayView: View {
    let model: AppModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if model.transcript.isEmpty {
                    Text("Waiting for transcript…")
                        .font(.title2).foregroundStyle(.white.opacity(0.3))
                        .frame(maxWidth: .infinity, minHeight: 200)
                } else {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(model.transcript) { line in
                            lineText(line)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        }
                        Color.clear.frame(height: 1).id(bottomID)
                    }
                    .padding(.horizontal, 56)
                    .padding(.vertical, 28)
                }
            }
            .onChange(of: model.transcript.last?.id) { _, _ in
                withAnimation { proxy.scrollTo(bottomID, anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo(bottomID, anchor: .bottom) }
        }
    }

    private let bottomID = "transcript-bottom"

    private func lineText(_ line: TranscriptLineDTO) -> some View {
        var attr = AttributedString()
        if let label = channelLabel(line) {
            var prefix = AttributedString(label.uppercased() + "  ")
            prefix.font = .system(size: 20, weight: .medium)
            prefix.foregroundColor = .white.opacity(0.4)
            attr += prefix
        }
        var body = AttributedString(line.text)
        body.font = .system(size: 40, weight: .regular)
        body.foregroundColor = channelColor(line.channel).opacity(line.isFinal ? 1 : 0.55)
        attr += body
        return Text(attr)
    }
}
