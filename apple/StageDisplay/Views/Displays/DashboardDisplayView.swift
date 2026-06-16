// DashboardDisplayView.swift — clock + PCO countdown + ProPresenter now/next +
// transcript strip. Mirrors the web dashboard display.

import SwiftUI

struct DashboardDisplayView: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 20) {
            ClockView()
            CountdownView(live: model.pcoLive)
            ProNowNextView(status: model.propresenter)
            Spacer()
            TranscriptStrip(lines: model.transcript)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ClockView: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(context.date, format: .dateTime.hour().minute().second())
                .font(.system(size: 48, weight: .semibold, design: .rounded))
                .monospacedDigit()
        }
    }
}

private struct ProNowNextView: View {
    let status: ProPresenterStatusDTO?

    var body: some View {
        VStack(spacing: 10) {
            row("NOW", status?.currentItem)
            row("NEXT", status?.nextItem)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func row(_ tag: String, _ text: String?) -> some View {
        HStack(spacing: 12) {
            Text(tag)
                .font(.caption).bold()
                .foregroundStyle(.secondary)
                .frame(width: 60, alignment: .leading)
            Text(text ?? "—")
                .font(.title2)
                .lineLimit(1)
            Spacer()
        }
    }
}
