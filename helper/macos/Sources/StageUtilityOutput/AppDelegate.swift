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
  private var showObserver: NSObjectProtocol?

  init(options: Options, paths: HelperPaths) {
    self.options = options
    self.paths = paths
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    model = AppModel(options: options, paths: paths)
    // Outputs make browsers, which CEF allows only once its context is up.
    CEFEngine.whenReady { [weak self] in self?.launch() }
  }

  private func launch() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = statusItem.button {
      button.image = NSImage(systemSymbolName: "display", accessibilityDescription: "Stage Utility Output")
      button.target = self
      button.action = #selector(toggleWindow)
    }
    model.start()
    // After start, so launch is decided below and only a LATER change calls this.
    model.onMenuBarCovered = { [weak self] in self?.showWindow() }
    // First run: say hello. Afterwards a menu bar app stays quiet unless asked.
    let hasState = FileManager.default.fileExists(atPath: paths.userDir.appendingPathComponent("outputs.json").path)
    if HelperWindowPolicy.opensAtLaunch(showWindowFlag: options.showWindow, hasStateFile: hasState, menuBarCovered: model.menuBarCovered) {
      showWindow()
    }
    // A second copy started by hand asks this one to show its window, then exits.
    showObserver = DistributedNotificationCenter.default().addObserver(
      forName: SingleInstance.showWindowRequest, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.showWindow() }
    }
  }

  /// Launching the app again, or `open -a`, while it runs: bring the window back.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow()
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

  private var quitting = false

  /// Every orderly quit, logout, restart and shutdown included, while Chromium runs:
  /// the browser host's application class calls this from its `terminate:` (see
  /// cef_host_mac.mm) instead of AppKit's, which would exit from inside the run loop.
  /// Every port is closed and every page with it before Chromium shuts down, so its
  /// processes go with the app; CEF then ends the loop, and main() exits. True when
  /// it is closing them, false to have AppKit terminate as usual (`QuitDecision`).
  @objc func tryToTerminateApplication(_ app: NSApplication) -> Bool {
    switch QuitDecision.onTerminate(engineRunning: CEFEngine.api != nil, alreadyQuitting: quitting) {
    case .letAppKitTerminate:
      return false
    case .alreadyClosing:
      return true
    case .closeOutputsThenEndLoop:
      quitting = true
      Log.notice(.app, "quitting: closing every output's port and page")
      model?.stopAll()
      CEFEngine.quit()
      return true
    }
  }

  /// Reached only when Chromium is not running. Never a cancel: macOS reads a cancel
  /// during a logout or restart as the app refusing it, and an unattended output Mac
  /// would stop restarting.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { .terminateNow }

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
