import AppKit
import StageUtilityOutputCore
import SwiftUI

/// The helper's window, built from the mockup's third tab: a dark 440 pt panel with
/// the connection line, the outputs each with a switch and a status line, and a
/// footer with Open at login and the version.
private enum Palette {
  static let window = Color(red: 0x1e / 255, green: 0x1e / 255, blue: 0x1e / 255)
  static let fg = Color(red: 0xed / 255, green: 0xed / 255, blue: 0xf0 / 255)
  static let muted = Color(red: 0x9a / 255, green: 0x9a / 255, blue: 0xa2 / 255)
  static let subtle = Color(red: 0x63 / 255, green: 0x63 / 255, blue: 0x6b / 255)
  static let accent = Color(red: 0x6a / 255, green: 0xa6 / 255, blue: 0xdf / 255)
  static let ok = Color(red: 0x86 / 255, green: 0xef / 255, blue: 0xac / 255)
  static let warn = Color(red: 0xff / 255, green: 0xca / 255, blue: 0x16 / 255)
  static let off = Color.white.opacity(0.14)
}

private extension Text {
  /// The window's secondary line: status, footer and version.
  func quiet() -> Text { font(.system(size: 12)).foregroundColor(Palette.subtle) }
}

/// The mockup's 32 x 19 pill.
private struct PillSwitch: ToggleStyle {
  func makeBody(configuration: Configuration) -> some View {
    Button {
      configuration.isOn.toggle()
    } label: {
      ZStack(alignment: configuration.isOn ? .trailing : .leading) {
        Capsule().fill(configuration.isOn ? Palette.accent : Palette.off).frame(width: 32, height: 19)
        Circle().fill(Palette.fg).frame(width: 15, height: 15).padding(2)
      }
      .animation(.easeOut(duration: 0.16), value: configuration.isOn)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(.isToggle)
    .accessibilityValue(configuration.isOn ? "on" : "off")
  }
}

struct HelperWindowView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 12) {
        connectionLine
        ForEach(model.notes, id: \.self) { note in
          Text(note)
            .font(.system(size: 12))
            .foregroundColor(Palette.warn)
            .fixedSize(horizontal: false, vertical: true)
        }
        VStack(alignment: .leading, spacing: 0) {
          Text("OUTPUTS")
            .font(.system(size: 11, weight: .semibold))
            .tracking(1.1)
            .foregroundColor(Palette.subtle)
            .padding(.bottom, 4)
          ForEach(model.rows) { row in outputRow(row) }
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading)

      Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1)
      footer
    }
    .frame(width: 440)
    .background(Palette.window)
    .environment(\.colorScheme, .dark)
  }

  private var dotColor: Color {
    switch model.connection {
    case .connected: return Palette.ok
    case .unreachable: return Palette.warn
    case .searching, .configured, .noOutputs: return Palette.subtle
    }
  }

  private var connectionLine: some View {
    let c = StatusText.connectionLine(model.connection)
    return HStack(spacing: 8) {
      Circle().fill(dotColor).frame(width: 8, height: 8)
      (Text(c.prefix).foregroundColor(Palette.fg)
        + Text(c.name ?? "").fontWeight(.semibold).foregroundColor(Palette.fg)
        + Text(c.middle ?? "").foregroundColor(Palette.fg)
        + Text(c.address ?? "").font(.system(size: 12, design: .monospaced)).foregroundColor(Palette.subtle))
        .font(.system(size: 13))
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func outputRow(_ row: OutputRow) -> some View {
    VStack(spacing: 0) {
      Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1)
      HStack(alignment: .center, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(row.title).font(.system(size: 13, weight: .semibold)).foregroundColor(Palette.fg)
          Text(row.status).quiet().fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        if row.switchable {
          Toggle(
            "Use \(row.title)",
            isOn: Binding(get: { row.enabled }, set: { model.setEnabled(row.id, $0) })
          )
          .toggleStyle(PillSwitch())
          .labelsHidden()
          .accessibilityLabel("Use \(row.title)")
        }
      }
      .padding(.vertical, 8)
    }
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        switch model.loginOffer {
        case .installed:
          // The LaunchAgent starts it; a switch here would add a second.
          Text("Starts at login (installed)").quiet()
        case .unavailable:
          Text("Open at login is not available with STAGE_UTILITY_OUTPUT_STATE_DIR").quiet()
        case .userSwitch(let on):
          Toggle("Open at login", isOn: Binding(get: { on }, set: { model.setLaunchAtLogin($0) }))
            .toggleStyle(PillSwitch())
            .labelsHidden()
            .accessibilityLabel("Open at login")
          Text("Open at login").quiet()
        }
        Spacer(minLength: 8)
        Text("v\(model.version)").quiet()
      }
      // An agent app has no menu to quit from. Not in the mockup, kept small and quiet.
      HStack {
        Spacer(minLength: 0)
        Button("Quit Stage Utility Output") { NSApp.terminate(nil) }
          .buttonStyle(.plain)
          .font(.system(size: 11))
          .foregroundColor(Palette.subtle)
      }
      if let error = model.launchAtLoginError {
        Text(error).font(.system(size: 11)).foregroundColor(Palette.warn).fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }
}

/// `--dump-frames` also writes the window itself, rendered off screen: a locked
/// screen cannot be photographed, and this needs no Screen Recording permission.
/// Only the render is on the main thread; encoding the PNG there held card outputs'
/// frames up for long enough to repeat some.
@MainActor
enum WindowSnapshot {
  static func write(model: AppModel, to file: URL) {
    let renderer = ImageRenderer(content: HelperWindowView(model: model))
    renderer.scale = 2
    guard let image = renderer.cgImage else {
      Log.error(.app, "could not render the window to an image")
      return
    }
    DispatchQueue.global(qos: .utility).async {
      if let why = PNGFile.write(image, to: file, called: "the window") { Log.error(.app, why) }
    }
  }
}
