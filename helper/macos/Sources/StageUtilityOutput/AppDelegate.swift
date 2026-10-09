import AppKit
import StageUtilityOutputCore
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let options: Options
  private let paths: HelperPaths
  private var model: AppModel!
  private var statusItem: NSStatusItem!
  private var window: NSWindow?

  init(options: Options, paths: HelperPaths) {
    self.options = options
    self.paths = paths
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    model = AppModel(options: options, paths: paths)
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = statusItem.button {
      button.image = NSImage(systemSymbolName: "display", accessibilityDescription: "Stage Utility Output")
      button.target = self
      button.action = #selector(toggleWindow)
    }
    model.start()
    // First run: say hello. Afterwards a menu bar app stays quiet unless asked.
    if options.showWindow || !FileManager.default.fileExists(atPath: paths.userDir.appendingPathComponent("outputs.json").path) {
      showWindow()
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

  @objc private func toggleWindow() {
    if let window, window.isVisible, NSApp.isActive { window.orderOut(nil) } else { showWindow() }
  }

  private func showWindow() {
    if window == nil {
      let controller = NSHostingController(rootView: HelperWindowView(model: model))
      controller.sizingOptions = [.preferredContentSize]
      let w = NSWindow(contentViewController: controller)
      w.title = "Stage Utility Output"
      w.styleMask = [.titled, .closable, .miniaturizable]
      w.isReleasedWhenClosed = false
      w.appearance = NSAppearance(named: .darkAqua)
      w.backgroundColor = NSColor(red: 0x1e / 255, green: 0x1e / 255, blue: 0x1e / 255, alpha: 1)
      // Above the output windows, or turning on the main display would bury the
      // switch that turns it off.
      w.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 2)
      w.center()
      window = w
    }
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }
}
