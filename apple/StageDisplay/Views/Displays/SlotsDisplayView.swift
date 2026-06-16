// SlotsDisplayView.swift — photo-forward slot cards (channel chip, scrim, name,
// initials fallback, device status) in a scrolling grid. Mirrors the web slot
// panel. Photos load through the server's /photos proxy.

import SwiftUI

struct SlotsDisplayView: View {
    let model: AppModel
    let displayId: String

    private let columns = [GridItem(.adaptive(minimum: 190), spacing: 12)]

    var body: some View {
        let slots = model.slots(for: displayId).sorted { $0.order < $1.order }
        ScrollView {
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(slots) { slot in
                    SlotCard(slot: slot, baseURL: model.baseURL)
                        .aspectRatio(3.0/4.0, contentMode: .fit)
                }
            }
            .padding(12)
        }
    }
}

private struct SlotCard: View {
    let slot: Slot
    let baseURL: URL?

    var body: some View {
        ZStack {
            background
            if isEmpty {
                VStack(spacing: 8) {
                    channelChip
                    Text("empty").font(.callout.weight(.medium)).foregroundStyle(.white.opacity(0.2))
                }
            } else {
                if photoURL == nil, let initials = initials {
                    Circle().fill(.white.opacity(0.10))
                        .overlay(Text(initials).font(.system(size: 34, weight: .bold)).foregroundStyle(.white.opacity(0.8)))
                        .frame(width: 90, height: 90)
                }
                scrim
                VStack(alignment: .leading, spacing: 0) {
                    HStack { channelChip; Spacer() }
                    Spacer()
                    Text(displayName ?? "—")
                        .font(.title2.weight(.semibold)).foregroundStyle(.white)
                        .lineLimit(2).shadow(color: .black.opacity(0.9), radius: 6, y: 1)
                    if let position {
                        Text(position).font(.subheadline).foregroundStyle(.white.opacity(0.7))
                            .lineLimit(1).shadow(color: .black.opacity(0.85), radius: 4, y: 1)
                    }
                    if slot.device.status != .none {
                        statusPill.padding(.top, 6)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)   // fill the aspect-ratio cell
        .background(Color(hex: "1a1a2e"))
        .clipShape(RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(.white.opacity(0.08), lineWidth: 1))
    }

    // MARK: Pieces

    @ViewBuilder private var background: some View {
        if let url = photoURL {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color(hex: "1a1a2e")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
        } else if let solid = solidColor {
            solid
        } else {
            Color(hex: "1a1a2e")
        }
    }

    private var scrim: some View {
        LinearGradient(
            colors: [.black.opacity(0.92), .black.opacity(0.45), .clear],
            startPoint: .bottom, endPoint: .top)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .allowsHitTesting(false)
    }

    private var channelChip: some View {
        Text(channelText)
            .font(.callout.weight(.semibold).monospacedDigit())
            .foregroundStyle(.white.opacity(0.9))
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(.white.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(0.18)))
            .shadow(color: .black.opacity(0.7), radius: 3)
    }

    private var statusPill: some View {
        HStack(spacing: 8) {
            if let rf = slot.device.rf {
                Label("\(Int(rf))", systemImage: "antenna.radiowaves.left.and.right")
            }
            if let battery = slot.device.battery {
                Label("\(Int(battery))%", systemImage: "battery.100")
            }
        }
        .font(.caption2).foregroundStyle(.white.opacity(0.85))
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(.black.opacity(0.4), in: Capsule())
    }

    // MARK: Derived

    private var isEmpty: Bool { if case .empty = slot.link { return true }; return false }

    private var displayName: String? {
        if let n = slot.displayName, !n.isEmpty { return n }
        if case .staticLabel(let label, _) = slot.link { return label }
        return nil
    }

    private var position: String? {
        if case .pcoPosition(let name, _) = slot.link { return name }
        return nil
    }

    private var solidColor: Color? {
        if case .staticLabel(_, let color) = slot.link { return Color(hex: color.replacingOccurrences(of: "#", with: "")) }
        return nil
    }

    private var initials: String? {
        guard let name = displayName else { return nil }
        let parts = name.split(separator: " ").prefix(2)
        let s = parts.compactMap { $0.first }.map(String.init).joined().uppercased()
        return s.isEmpty ? nil : s
    }

    private var channelText: String {
        if let n = Int(slot.channel) { return String(format: "%02d", n) }
        return slot.channel
    }

    private var photoURL: URL? {
        guard !isEmpty, let p = slot.photoUrl, !p.isEmpty, let base = baseURL,
              var c = URLComponents(url: base.appendingPathComponent("/photos"), resolvingAgainstBaseURL: false)
        else { return nil }
        c.queryItems = [URLQueryItem(name: "u", value: p)]
        return c.url
    }
}
