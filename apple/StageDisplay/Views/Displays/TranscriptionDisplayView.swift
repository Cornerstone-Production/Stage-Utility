// TranscriptionDisplayView.swift — full-screen captions that auto-scroll to the
// newest line. Mirrors the web transcription display.

import SwiftUI

struct TranscriptionDisplayView: View {
    let model: AppModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(model.transcript) { line in
                        VStack(alignment: .leading, spacing: 2) {
                            if let name = line.channelName, !name.isEmpty {
                                Text(name.uppercased())
                                    .font(.caption).bold()
                                    .foregroundStyle(.secondary)
                            }
                            Text(line.text)
                                .font(.system(size: 34, weight: .medium))
                                .foregroundStyle(line.isFinal ? .primary : .secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .id(line.id)
                    }
                }
                .padding(.horizontal, 48)
                .padding(.vertical, 24)
            }
            .onChange(of: model.transcript.last?.id) { _, newID in
                guard let newID else { return }
                withAnimation { proxy.scrollTo(newID, anchor: .bottom) }
            }
        }
    }
}
