import AppKit
import StageUtilityCEFHostAPI
import StageUtilityOutputCore

/// Chromium, through the browser host (CEFHost/, opened at run time). One per
/// process: it makes the app object, starts CEF, and runs the event loop.
///
/// The event loop is CEF's (`CefRunMessageLoop`), not an external pump: on macOS it
/// IS AppKit's `-[NSApplication run]`, with Chromium's work scheduled on the same run
/// loop, so the menu bar, the window, timers and every browser share one loop and
/// nothing polls. An external pump (`CefDoMessageLoopWork` on a timer) is for an app
/// that cannot give its loop away, and CEF documents it as the slower choice.
///
/// When the host cannot be opened or CEF does not start, the app still runs on a
/// plain AppKit loop: it finds the server and lists its outputs, and says in its
/// window and the log that nothing can be drawn and why.
@MainActor
enum CEFEngine {
  private enum State {
    case notStarted
    case ready(UnsafePointer<su_cef_api>)
    case failed(String)
  }

  private static var state = State.notStarted
  private static var onReady: [() -> Void] = []
  private static var contextReady = false

  static var api: UnsafePointer<su_cef_api>? {
    if case .ready(let api) = state { return api }
    return nil
  }

  static var failure: String? {
    if case .failed(let why) = state { return why }
    return nil
  }

  /// The host inside the app bundle.
  private static var hostPath: String {
    (Bundle.main.privateFrameworksPath ?? Bundle.main.bundlePath + "/Contents/Frameworks") + "/libStageUtilityCEFHost.dylib"
  }

  /// Open the host, make the app object CEF needs, and start CEF. Must run before
  /// anything else touches `NSApplication.shared`. Returns the app.
  static func start(paths: HelperPaths) -> NSApplication {
    var error = [CChar](repeating: 0, count: 1024)
    guard FileManager.default.fileExists(atPath: hostPath) else {
      return fail("the browser host is not in the app (\(hostPath)); build the app with build-app.sh")
    }
    guard let api = su_cef_load(hostPath, &error, error.count) else {
      return fail("the browser host could not be opened (\(String(nulTerminated: error)))")
    }
    let className = String(cString: api.pointee.application_class_name!()!)
    guard let appClass = NSClassFromString(className) as? NSApplication.Type else {
      return fail("the browser host has no application class \(className)")
    }
    let app = appClass.shared

    let profile = paths.userDir.appendingPathComponent("Chromium", isDirectory: true)
    do {
      try PrivateFiles.makeDirectory(paths.userDir)
    } catch {
      _ = fail("could not make \(paths.userDir.path) for Chromium's profile: \(error.localizedDescription)")
      return app
    }
    let chromiumLog = paths.userDir.appendingPathComponent("chromium.log")
    logCapOutcome(Result { try LogFileCap.enforce(chromiumLog) })
    // The host copies the switches during `initialize`.
    let switches = ChromiumSwitches.browser.map { strdup($0) }
    defer { switches.forEach { free($0) } }
    let ok = profile.path.withCString { cache in
      chromiumLog.path.withCString { logFile in
        switches.map { UnsafePointer($0) }.withUnsafeBufferPointer { list in
          var settings = su_cef_settings(
            cache_path: cache, log_file: logFile, switches: list.baseAddress, switch_count: list.count, context: nil,
            context_initialized: { _ in MainActor.assumeIsolated { CEFEngine.contextInitialized() } })
          return api.pointee.initialize!(&settings, &error, error.count)
        }
      }
    }
    guard ok else {
      _ = fail("Chromium did not start: \(String(nulTerminated: error))")
      return app
    }
    state = .ready(api)
    // Off the main thread, which also draws every output: a trim reads and
    // writes 5 MB. Only its outcome comes back here, to be logged.
    logCapTimer = Timer.scheduledTimer(withTimeInterval: LogFileCap.checkInterval, repeats: true) { _ in
      DispatchQueue.global(qos: .utility).async {
        let outcome = Result { try LogFileCap.enforce(chromiumLog) }
        DispatchQueue.main.async { MainActor.assumeIsolated { logCapOutcome(outcome) } }
      }
    }
    Log.notice(
      .cef,
      "Chromium started: CEF \(String(cString: api.pointee.cef_version!()!)), sandbox \(api.pointee.sandboxed!() ? "on" : "off")")
    return app
  }

  /// Held so the repeating check has an owner; the run loop retains it too.
  private static var logCapTimer: Timer?
  private static var logCapFailing = false

  /// What keeping Chromium's own log under its cap did (see `LogFileCap`). A
  /// check that keeps failing is logged when it starts failing and when it
  /// works again.
  private static func logCapOutcome(_ result: Result<LogFileCap.Outcome, Error>) {
    do {
      let outcome = try result.get()
      if logCapFailing {
        logCapFailing = false
        Log.notice(.cef, "chromium.log can be kept under \(LogFileCap.capBytes / 1_048_576) MB again")
      }
      if case .trimmed(let from, let kept) = outcome {
        Log.notice(.cef, "chromium.log reached \(mb(from)) MB; kept its last \(mb(kept)) MB")
      }
    } catch {
      guard !logCapFailing else { return }
      logCapFailing = true
      Log.error(.cef, "could not keep chromium.log under \(LogFileCap.capBytes / 1_048_576) MB: \(error.localizedDescription); trying again every \(Int(LogFileCap.checkInterval / 60)) min")
    }
  }

  private static func mb(_ bytes: Int) -> String { String(format: "%.1f", Double(bytes) / 1_048_576) }

  private static func fail(_ why: String) -> NSApplication {
    state = .failed(why)
    Log.error(.cef, why)
    return NSApplication.shared
  }

  /// Run `body` once CEF can make browsers, or at once if it already can. When CEF
  /// failed, `body` runs at once too: it reads `failure` and says so.
  static func whenReady(_ body: @escaping () -> Void) {
    if contextReady || api == nil { body() } else { onReady.append(body) }
  }

  private static func contextInitialized() {
    contextReady = true
    let waiting = onReady
    onReady = []
    for body in waiting { body() }
  }

  /// The event loop, until `quit()`. Returns once CEF has shut down.
  static func run(_ app: NSApplication) {
    guard let api else {
      app.run()
      return
    }
    api.pointee.run_message_loop!()
    api.pointee.shutdown!()
  }

  /// Close every browser, then end the loop. With no CEF, the app terminates.
  static func quit() {
    if let api {
      api.pointee.quit_when_closed!()
    } else {
      NSApp.terminate(nil)
    }
  }
}
