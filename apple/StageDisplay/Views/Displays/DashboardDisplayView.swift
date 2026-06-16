// DashboardDisplayView.swift — 2×2 glass-card grid (time · timer · PP now · up
// next) + transcript pill. Mirrors the web dashboard.

import SwiftUI

struct DashboardDisplayView: View {
    let model: AppModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let now = context.date
            VStack(spacing: 12) {
                Grid(horizontalSpacing: 12, verticalSpacing: 12) {
                    GridRow {
                        timeCard(now)
                        timerCard(now)
                    }
                    GridRow {
                        proNowCard
                        upNextCard
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                TranscriptStrip(lines: model.transcript)
            }
            .padding(16)
        }
    }

    // MARK: Cards

    private func timeCard(_ now: Date) -> some View {
        let c = Calendar.current.dateComponents([.hour, .minute, .second], from: now)
        let h = c.hour ?? 0
        let h12 = (h % 12 == 0) ? 12 : h % 12
        return GlassCard(label: "Current time") {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(h12):\(two(c.minute))")
                    .font(.system(size: 64, weight: .medium)).foregroundStyle(.white.opacity(0.9))
                Text(":\(two(c.second))").font(.system(size: 28)).foregroundStyle(.white.opacity(0.45))
                Text(h < 12 ? "AM" : "PM").font(.system(size: 18)).foregroundStyle(.white.opacity(0.4))
            }
            .monospacedDigit().lineLimit(1).minimumScaleFactor(0.4)
        }
    }

    private func timerCard(_ now: Date) -> some View {
        let t = Countdown.display(model.pcoLive, now: now)
        return GlassCard(label: timerHeader(now: now), accent: t == nil ? .neutral : (t!.over ? .red : .green)) {
            if let t {
                VStack(spacing: 6) {
                    Text(t.value)
                        .font(.system(size: 64, weight: .medium)).monospacedDigit()
                        .foregroundStyle(t.over ? .red : Palette.green)
                        .lineLimit(1).minimumScaleFactor(0.4)
                    Text(t.label).font(.caption).foregroundStyle(.white.opacity(0.45)).lineLimit(1)
                }
            } else {
                Text("No live service").foregroundStyle(.white.opacity(0.35))
            }
        }
    }

    private var proNowCard: some View {
        let pro = model.propresenter
        return GlassCard(label: "ProPresenter · now", alignment: .center) {
            if pro?.connected == true {
                VStack(alignment: .leading, spacing: 10) {
                    Text(pro?.currentItem ?? "—")
                        .font(.system(size: 30, weight: .medium)).foregroundStyle(.white.opacity(0.9))
                        .lineLimit(1).minimumScaleFactor(0.5)
                    if let idx = pro?.slideIndex, let count = pro?.slideCount, count > 0 {
                        HStack(spacing: 10) {
                            Text("Slide \(idx) of \(count)").font(.caption).foregroundStyle(.white.opacity(0.45)).monospacedDigit()
                            ProgressBar(fraction: Double(idx) / Double(count))
                            Text("\(pro?.slidesRemaining ?? 0) left").font(.caption).foregroundStyle(.white.opacity(0.6)).monospacedDigit()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("ProPresenter offline").foregroundStyle(.white.opacity(0.35))
            }
        }
    }

    private var upNextCard: some View {
        let pro = model.propresenter
        return GlassCard(label: "Up next") {
            Text(pro?.connected == true ? (pro?.nextItem ?? "—") : "—")
                .font(.system(size: 30, weight: .medium)).foregroundStyle(.white.opacity(0.7))
                .lineLimit(2).minimumScaleFactor(0.5)
        }
    }

    // MARK: Helpers

    private func timerHeader(now: Date) -> String {
        guard let live = model.pcoLive, let r = Countdown.remaining(live, now: now) else { return "Service timer" }
        switch live.mode {
        case .preservice: return "Service starts in"
        case .item: return r < 0 ? "Live · item over" : "Live · item remaining"
        case .none: return "Service timer"
        }
    }

    private func two(_ n: Int?) -> String { String(format: "%02d", n ?? 0) }
}

/// Thin progress bar matching the web slide-progress indicator.
struct ProgressBar: View {
    let fraction: Double
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.10))
                Capsule().fill(.white.opacity(0.5))
                    .frame(width: max(0, min(1, fraction)) * geo.size.width)
            }
        }
        .frame(height: 4)
    }
}
