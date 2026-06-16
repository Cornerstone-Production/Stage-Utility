// StageConfidenceView.swift — the dense confidence display: big current slide
// text, section chips, chords (notes), next slide, countdown, transcript strip.
// Mirrors the web "stage" display. (Named *Confidence* to avoid colliding with
// the web file name; it is the "stage" DisplayKind.)

import SwiftUI

struct StageConfidenceView: View {
    let model: AppModel

    var body: some View {
        let pp = model.propresenter
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                if let section = pp?.currentSection {
                    SectionChip(section: section)
                }
                Spacer()
                CountdownView(live: model.pcoLive).fixedSize()
            }

            Text(pp?.currentSlideText ?? "—")
                .font(.system(size: 56, weight: .bold))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            if let notes = pp?.currentNotes, !notes.isEmpty {
                Text(notes)
                    .font(.title3)
                    .foregroundStyle(.yellow)
            }

            Divider().overlay(.white.opacity(0.2))

            HStack(alignment: .top, spacing: 12) {
                if let next = pp?.nextArrangementSection ?? pp?.nextSection {
                    SectionChip(section: next)
                }
                Text(pp?.nextSlideText ?? "—")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                Spacer()
            }

            TranscriptStrip(lines: model.transcript)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct SectionChip: View {
    let section: ProSection

    var body: some View {
        Text(section.name.uppercased())
            .font(.caption).bold()
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Color(hex: section.colorHex) ?? .gray, in: Capsule())
            .foregroundStyle(.white)
    }
}
