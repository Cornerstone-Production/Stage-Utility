// StageConfidenceView.swift — the dense confidence display: remaining/clock/PCO
// strip, big current slide + live preview, next bar, service items, transcript.
// Mirrors the web "stage" display.

import SwiftUI

struct StageConfidenceView: View {
    let model: AppModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let now = context.date
            let pro = model.propresenter
            VStack(spacing: 10) {
                topStrip(now)
                    .frame(height: 116)
                currentRow(pro)
                    .frame(maxHeight: .infinity)
                nextBar(pro)
                    .frame(height: 68)
                serviceItems(pro)
                    .frame(height: 92)
                TranscriptStrip(lines: model.transcript)
            }
            .padding(12)
        }
    }

    // MARK: Top strip — remaining · clock · PCO live

    private func topStrip(_ now: Date) -> some View {
        let pro = model.propresenter
        let t = Countdown.display(model.pcoLive, now: now, skew: model.pcoSkew)
        let c = Calendar.current.dateComponents([.hour, .minute, .second], from: now)
        let h = c.hour ?? 0, h12 = (h % 12 == 0) ? 12 : h % 12
        return HStack(spacing: 10) {
            GlassCard(label: "Remaining slides") {
                Text(pro?.slidesRemaining.map(String.init) ?? "—")
                    .font(.system(size: 48, weight: .medium)).monospacedDigit()
                    .lineLimit(1).minimumScaleFactor(0.4)
            }
            GlassCard(label: "Clock") {
                Text(clockString(h12: h12, minute: c.minute, second: c.second, pm: h >= 12))
                    .font(.system(size: 40, weight: .medium)).monospacedDigit()
                    .lineLimit(1).minimumScaleFactor(0.4)
            }
            GlassCard(label: pcoHeader(now), accent: t == nil ? .neutral : (t!.over ? .red : .green)) {
                if let t {
                    VStack(spacing: 4) {
                        Text(t.value).font(.system(size: 40, weight: .medium)).monospacedDigit()
                            .foregroundStyle(t.over ? .red : Palette.green).lineLimit(1).minimumScaleFactor(0.4)
                        Text(t.label).font(.caption2).foregroundStyle(.white.opacity(0.4)).lineLimit(1)
                    }
                } else {
                    Text("No live service").font(.callout).foregroundStyle(.white.opacity(0.35))
                }
            }
        }
    }

    // MARK: Current slide + preview

    private func currentRow(_ pro: ProPresenterStatusDTO?) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("NOW").font(.system(size: 11, weight: .medium)).tracking(1.2).foregroundStyle(.white.opacity(0.4))
                    SectionChip(section: pro?.currentSection)
                    Spacer()
                    if let notes = pro?.currentNotes, !notes.isEmpty {
                        Text(notes).font(.system(size: 18, weight: .medium)).foregroundStyle(Palette.amber).monospacedDigit()
                    }
                }
                Text(pro?.connected == true ? (pro?.currentSlideText ?? "—") : "ProPresenter offline")
                    .font(.system(size: 44, weight: .medium))
                    .lineLimit(4).minimumScaleFactor(0.4)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            }
            .padding(16)
            .background(Palette.cardBG, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.cardBorder, lineWidth: 1))

            if let url = thumbnailURL(pro) {
                AsyncImage(url: url) { image in
                    image.resizable().aspectRatio(contentMode: .fit)
                } placeholder: {
                    Color.black
                }
                .aspectRatio(16.0/9.0, contentMode: .fit)
                .background(Color.black)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.cardBorder, lineWidth: 1))
            }
        }
    }

    // MARK: Next bar

    private func nextBar(_ pro: ProPresenterStatusDTO?) -> some View {
        HStack(spacing: 12) {
            Text("NEXT").font(.system(size: 11, weight: .medium)).tracking(1.2).foregroundStyle(.white.opacity(0.4))
            SectionChip(section: pro?.nextSection, small: true)
            Text(pro?.nextSlideText ?? "—")
                .font(.system(size: 26, weight: .medium)).foregroundStyle(Palette.amber)
                .lineLimit(1).minimumScaleFactor(0.5)
            Spacer(minLength: 8)
            if let then = pro?.nextArrangementSection {
                Text("THEN").font(.system(size: 11, weight: .medium)).tracking(1.2).foregroundStyle(.white.opacity(0.3))
                SectionChip(section: then, small: true)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.amber.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.amber.opacity(0.25), lineWidth: 1))
    }

    // MARK: Service items

    private func serviceItems(_ pro: ProPresenterStatusDTO?) -> some View {
        HStack(spacing: 10) {
            GlassCard(label: "Current service item", alignment: .leading) {
                Text(pro?.currentServiceItem ?? "—")
                    .font(.system(size: 24, weight: .medium)).lineLimit(1).minimumScaleFactor(0.5)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            GlassCard(label: "Next service item", accent: .amber, alignment: .leading) {
                HStack {
                    Text(pro?.nextServiceItem ?? "—")
                        .font(.system(size: 24, weight: .medium)).foregroundStyle(Palette.amber)
                        .lineLimit(1).minimumScaleFactor(0.5)
                    Spacer()
                    if let timers = pro?.timers, !timers.isEmpty {
                        ForEach(timers.prefix(2), id: \.name) { t in
                            Text(timerString(name: t.name, time: t.time)).font(.caption)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: Helpers

    private func pcoHeader(_ now: Date) -> String {
        guard let live = model.pcoLive, let r = Countdown.remaining(live, now: now, skew: model.pcoSkew) else { return "Planning Center Live" }
        switch live.mode {
        case .preservice: return "Service starts in"
        case .item: return r < 0 ? "PCO Live · over" : "PCO Live · remaining"
        case .none: return "Planning Center Live"
        }
    }

    private func thumbnailURL(_ pro: ProPresenterStatusDTO?) -> URL? {
        guard pro?.connected == true, let key = pro?.slidePreviewKey, let base = model.baseURL,
              var comps = URLComponents(url: base.appendingPathComponent("/api/propresenter/thumbnail"), resolvingAgainstBaseURL: false)
        else { return nil }
        comps.queryItems = [URLQueryItem(name: "k", value: key)]
        return comps.url
    }

    private func two(_ n: Int?) -> String { String(format: "%02d", n ?? 0) }

    private func clockString(h12: Int, minute: Int?, second: Int?, pm: Bool) -> AttributedString {
        let head = AttributedString("\(h12):\(two(minute))")
        var tail = AttributedString(":\(two(second)) \(pm ? "PM" : "AM")")
        tail.foregroundColor = .white.opacity(0.45)
        return head + tail
    }

    private func timerString(name: String, time: String) -> AttributedString {
        var n = AttributedString("\(name): ")
        n.foregroundColor = .white.opacity(0.55)
        var v = AttributedString(time)
        v.foregroundColor = .white.opacity(0.8)
        return n + v
    }
}
