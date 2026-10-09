import AppKit
import DeckLinkKit
import ServiceManagement
import StageUtilityOutputCore
import SwiftUI

/// What the helper's window shows for one output.
struct OutputRow: Identifiable, Equatable {
  var id: String
  var title: String
  var enabled: Bool
  var status: String
}

/// Everything the helper decides, in one place: which outputs exist, which are on,
/// where each one's server is, what each shows, and what to tell the operator.
@MainActor
final class AppModel: ObservableObject {
  @Published private(set) var rows: [OutputRow] = []
  @Published private(set) var connection: StatusText.Connection = .noOutputs
  /// Things that are wrong or worth knowing, shown under the connection line.
  @Published private(set) var notes: [String] = []
  @Published private(set) var launchAtLogin = false
  @Published private(set) var launchAtLoginError: String?
  let version: String
  /// Called when a change in the displays leaves the menu bar covered by an output
  /// that did not cover it before: the icon is hidden, so the window has to come up.
  var onMenuBarCovered: (() -> Void)?

  private let options: Options
  private let identity: MacIdentity
  private let store: OutputStateStore
  private let macs: [String]
  private let hostname: String

  /// Per output, keyed by output key.
  private final class Runtime {
    var output: PresentOutput
    var descriptor: OutputDescriptor { output.descriptor }
    var sink: OutputSink?
    var discovery: OutputDiscovery?
    var serverURL: String?
    var serverName: String?
    var loaded = false
    var unreachable = false
    /// What the committed page is. Not what is being loaded: see `ScreenPage`.
    var page: ScreenPage = .other
    var showingBound: Bool { page.isBound }
    var boundScreenName: String?
    /// The bound screen's rotation, as the server last said. Kept when the page goes
    /// back to the holding screen: it describes how the monitor is mounted.
    var rotation: Rotation = .none
    /// A card output's format, as the bound screen last said; nil is the default.
    /// Kept on the holding screen, like the rotation.
    var videoMode: String?
    /// Why the screens could not be read, while they cannot: logged once, not per try.
    var screenReadProblem: String?
    var fps: Double?
    /// Times the page's renderer has ended since launch, for the window.
    var crashes = 0
    init(output: PresentOutput) { self.output = output }
  }
  private var runtimes: [String: Runtime] = [:]
  private var order: [String] = []

  // One note per cause, so a repeated cause does not stack.
  private var noteTable: [String: String] = [:]
  /// What each output's health posts have been told, by output key.
  private var healthBoard = HealthBoard()
  private var healthTimer: Timer?
  /// The DeckLink driver and its ports: scanned at start and on every device
  /// change, logged when they change.
  private let deckLink = DeckLinkInventory(log: Log.decklink)
  private var dumpTimer: Timer?
  private var dumpSequence = 0

  init(options: Options, paths: HelperPaths) {
    self.options = options
    self.version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    self.identity = MacIdentity.load(paths: paths)
    self.store = OutputStateStore(directory: paths.userDir)
    self.macs = HardwareAddresses.current()
    self.hostname = Host.current().localizedName ?? ProcessInfo.processInfo.hostName

    switch identity.source {
    case .installer:
      Log.notice(.state, "Mac device id \(identity.deviceId) from the installer")
    case .generated:
      Log.notice(.state, "no device id from the installer; using the one this helper generated: \(identity.deviceId)")
      setNote("identity", "No device id from the installer. This Mac uses one the helper generated.")
    }
    if let e = identity.saveError {
      Log.error(.state, e)
      setNote("identity-save", "A new device id could not be saved, so a restart would orphan every setup. \(e)")
    }
    if let problem = identity.serverProblem {
      Log.error(.discovery, "\(problem); it is ignored and the server is looked for on the network")
      setNote("server-file", "Ignoring \(problem).")
    }
    if let server = identity.server { Log.notice(.discovery, "server file names \(server); probes go to it alone, by unicast") }
    if let problem = store.readProblem {
      Log.error(.state, "\(problem); it is left as it is and nothing is saved until it is fixed or removed and the helper restarted")
      setNote("state-unreadable", "\(problem). Outputs keep working, but nothing is saved, and each launch makes new tokens, until it is fixed or removed and the helper restarted.")
    }
    if let problem = identity.readProblem {
      Log.error(.state, "\(problem)")
      setNote("identity-read", "\(problem). It is left as it is.")
    }
    if let why = CEFEngine.failure { setNote("cef", WebSurfaces.unavailable(why)) }
    launchAtLogin = SMAppService.mainApp.status == .enabled
  }

  // MARK: Start

  func start() {
    scanDeckLink()
    // On the driver's thread, for a device arriving or going. Without a driver
    // there is nothing to watch, and installing one takes a restart.
    DeckLinkDriver.watchDevices { [weak self] in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.deckLinkDevicesChanged() } }
    }
    reconcile()
    NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.displaysChanged() }
    }
    healthTimer = Timer.scheduledTimer(withTimeInterval: HealthPost.interval, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.healthTick() }
    }
    if options.dumpFramesDir != nil { startDumping() }
    gpuWatch.start()
  }

  /// Before the app quits: close every output's page and stop every clock.
  func stopAll() {
    gpuWatch.stop()
    for key in order { deactivate(key) }
  }

  private let gpuWatch = GPUProcessWatch()

  // MARK: Outputs

  /// How long the displays must stay as they are before the outputs follow them. A
  /// display can vanish for a moment on wake or when a hub renegotiates, and tearing
  /// down a window and its browser for that, then building them again, drops the
  /// page and reloads it.
  static let displayChangeSettle: TimeInterval = 1
  private var displayChange: DispatchWorkItem?

  private func displaysChanged() {
    displayChange?.cancel()
    let work = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        Log.notice(.output, "the display arrangement changed")
        self?.reconcile()
      }
    }
    displayChange = work
    DispatchQueue.main.asyncAfter(deadline: .now() + AppModel.displayChangeSettle, execute: work)
  }

  /// Read the DeckLink driver and its ports. Without a working driver the window
  /// says why, once, and there are simply no DeckLink outputs.
  private func scanDeckLink() {
    let status = deckLink.scan().status
    if let problem = status.problem { setNote("decklink", "\(problem).") } else { clearNote("decklink") }
  }

  /// A DeckLink device arrived or went: announce any new port, and have every lost
  /// port try again now rather than at its next retry.
  private func deckLinkDevicesChanged() {
    scanDeckLink()
    reconcile()
    for key in order { (runtimes[key]?.sink as? CardOutput)?.retry() }
  }

  /// Make the runtimes match the displays macOS lists now, every DeckLink port
  /// found since launch, and the virtual card outputs `--virtual-sdi` asks for.
  private func reconcile() {
    let outputs = DisplayEnumerator.current().map(PresentOutput.init(display:))
      + deckLink.seen.map { PresentOutput(descriptor: $0.descriptor, card: .port($0)) }
      + VirtualCards.outputs(count: options.virtualSDI).map { PresentOutput(descriptor: $0, card: .virtual) }
    let present = Set(outputs.map { $0.descriptor.key })
    for key in order where !present.contains(key) {
      Log.notice(.output, "\(runtimes[key]?.descriptor.port ?? key) is gone; its window is closed")
      deactivate(key)
      runtimes[key] = nil
    }
    order = outputs.map { $0.descriptor.key }
    for d in outputs {
      let key = d.descriptor.key
      let record = ensureRecord(d.descriptor)
      if let rt = runtimes[key] {
        rt.output = d
        if let screen = d.screen { (rt.sink as? DisplaySink)?.follow(screen) }
      } else {
        runtimes[key] = Runtime(output: d)
        Log.notice(.output, "\(d.descriptor.name) (\(d.descriptor.key)): \(record.enabled ? "on" : "off")\(d.descriptor.isMain ? ", main display" : "")")
      }
      let rt = runtimes[key]!
      if record.enabled, rt.sink == nil { activate(key) }
      if !record.enabled, rt.sink != nil { deactivate(key) }
    }
    let covered = menuBarCovered
    refresh()
    if HelperWindowPolicy.opensOnChange(wasCovered: wasMenuBarCovered, isCovered: covered) { onMenuBarCovered?() }
    wasMenuBarCovered = covered
  }

  /// An output window is over the display that has the menu bar, and so over the icon.
  var menuBarCovered: Bool {
    order.contains { key in
      guard let rt = runtimes[key] else { return false }
      return rt.descriptor.isMain && rt.sink != nil
    }
  }
  private var wasMenuBarCovered = false

  private func ensureRecord(_ d: OutputDescriptor) -> OutputRecord {
    do {
      let fresh = store.record(for: d.key) == nil
      let record = try store.ensure(d, mac: identity)
      if fresh, record.kioskIdentity == true {
        Log.notice(.state, "\(d.name) takes over this Mac's Chrome kiosk: device id \(identity.deviceId), the installer's token, on")
      }
      return record
    } catch {
      // The record exists in memory with its token; only the file is behind.
      noteSaveFailure(error)
      return store.record(for: d.key)!
    }
  }

  func setEnabled(_ key: String, _ on: Bool) {
    guard runtimes[key] != nil else { return }
    do {
      try store.setEnabled(on, key: key)
    } catch {
      noteSaveFailure(error)
    }
    Log.notice(.output, "\(runtimes[key]!.descriptor.name): turned \(on ? "on" : "off") in the window")
    if on { activate(key) } else { deactivate(key) }
    // Done from the window itself, which is up: nothing to pop.
    wasMenuBarCovered = menuBarCovered
    refresh()
  }

  private func activate(_ key: String) {
    guard let rt = runtimes[key], rt.sink == nil else { return }
    let d = rt.descriptor
    let sink: OutputSink
    if let screen = rt.output.screen {
      sink = DisplaySink(descriptor: d, screen: screen)
    } else if let card = rt.output.card {
      sink = CardOutput(descriptor: d, hardware: card)
    } else {
      Log.error(.output, "\(d.port): neither a display nor a card port; not started")
      return
    }
    rt.sink = sink
    if !sink.surfaceProblems.isEmpty {
      for problem in sink.surfaceProblems { Log.error(.output, "\(d.port): \(problem)") }
      setNote("surface", Array(Set(sink.surfaceProblems)).sorted().joined(separator: " "))
    }
    sink.surface.onProcessGone = { [weak self, weak rt] _ in
      guard let self, let rt else { return }
      rt.crashes += 1
      self.setNote(
        "crash-\(key)",
        "\(d.port): its page has crashed \(rt.crashes == 1 ? "once" : "\(rt.crashes) times") since launch. It is reloaded each time; the log says why.")
    }
    sink.surface.onLoadResult = { [weak self, weak rt] failures in
      guard let self, let rt else { return }
      self.loadResult(key, rt, failures: failures)
    }
    sink.surface.onCommitted = { [weak self, weak rt] url in
      guard let self, let rt else { return }
      self.pageMoved(rt, to: url)
    }

    // With a `server` file the page loads from it at once and the probes go to that
    // server alone, so the output still shows up under "Not set up yet".
    var mode = OutputDiscovery.Mode.broadcast
    if let server = identity.server {
      rt.serverURL = server
      navigate(rt)
      if let host = EnrollURL.host(of: server) { mode = .unicast(host: host) }
    }
    let discovery = OutputDiscovery(
      label: d.port, port: options.discoveryPort, mode: mode,
      boundTo: { [weak self] in self?.store.record(for: key)?.boundTo },
      makeProbe: { [weak self, weak rt] unreachable in self?.probe(for: rt, unreachable: unreachable) ?? Data() })
    discovery.onReply = { [weak self, weak rt] reply in
      guard let self, let rt else { return }
      self.heard(key, rt, reply)
    }
    discovery.onLocalNetworkSuspected = { [weak self] in self?.suspectLocalNetwork() }
    rt.discovery = discovery
    discovery.start()
  }

  private func deactivate(_ key: String) {
    guard let rt = runtimes[key] else { return }
    rt.discovery?.stop()
    rt.discovery = nil
    rt.sink?.stop()
    rt.sink = nil
    rt.loaded = false
    rt.unreachable = false
    rt.page = .other
    rt.rotation = .none
    rt.videoMode = nil
    rt.screenReadProblem = nil
    rt.boundScreenName = nil
    rt.fps = nil
    healthBoard.forget(key)
    // A server from discovery is looked for again on the next turn-on; one from the
    // server file stays.
    if identity.server == nil { rt.serverURL = nil }
  }

  private func probe(for rt: Runtime?, unreachable: Bool) -> Data {
    guard let rt else { return Data() }
    let d = rt.descriptor
    return Probe(
      id: deviceId(rt), macs: macs, hostname: hostname, boundTo: store.record(for: d.key)?.boundTo,
      unreachable: unreachable, descriptor: d
    ).encoded()
  }

  private func deviceId(_ rt: Runtime) -> String {
    let key = rt.descriptor.key
    return store.record(for: key)?.deviceId(mac: identity.deviceId, key: key) ?? DeviceIdentity.deviceId(mac: identity.deviceId, key: key)
  }

  // MARK: Server

  private func heard(_ key: String, _ rt: Runtime, _ reply: DiscoveryReply) {
    rt.serverName = reply.name
    clearLocalNetworkSuspicion()
    // A server file names the server; an answer from it only says it is there.
    if identity.server == nil, rt.serverURL != reply.url {
      Log.notice(.discovery, "\(rt.descriptor.port): server is \"\(reply.name)\" at \(reply.url)")
      rt.serverURL = reply.url
      navigate(rt)
    }
    do {
      try store.setBoundTo(reply.serverId, key: key)
    } catch {
      noteSaveFailure(error)
    }
    refresh()
  }

  private func navigate(_ rt: Runtime) {
    guard let server = rt.serverURL, let token = store.record(for: rt.descriptor.key)?.token,
      let url = EnrollURL.make(server: server, deviceId: deviceId(rt), token: token)
    else {
      Log.error(.output, "\(rt.descriptor.port): no usable server address to load")
      return
    }
    rt.sink?.show(url: url)
  }

  private func loadResult(_ key: String, _ rt: Runtime, failures: Int) {
    if failures == 0 {
      rt.loaded = true
      rt.unreachable = false
      clearLocalNetworkSuspicion()
    } else {
      rt.unreachable = true
      // Only the failure that crosses the line: not one restart per retry.
      if Backoff.shouldRediscover(afterFailureNumber: failures), identity.server == nil {
        Log.notice(.discovery, "\(rt.descriptor.port): \(failures) loads failed in a row; searching for the server again")
        rt.discovery?.restart()
      }
    }
    refresh()
  }

  /// A page committed in this output's browser.
  private func pageMoved(_ rt: Runtime, to url: URL) {
    guard let server = rt.serverURL else { return }
    let port = rt.descriptor.port
    let page = ScreenPage.classify(committed: url, server: server)
    guard page != rt.page else { return }
    switch page {
    case .bound(let ref):
      Log.notice(.output, "\(port): claimed, showing \(ref)")
      // Set up (again): the server may know this output now, so health posts resume.
      healthBoard.boundAgain(rt.descriptor.key)
    case .holding:
      Log.notice(.output, "\(port): showing the holding screen")
    case .other:
      Log.notice(.output, "\(port): showing a page that is neither the holding screen nor a screen")
    }
    rt.page = page
    if !page.isBound { rt.boundScreenName = nil }
    refresh()
    if page.isBound { readScreens() }
  }

  /// Read the screens the bound outputs show: their names and rotations. One request
  /// per server, answered for every output bound to it. Called when a page becomes a
  /// screen and every ten seconds after, so a rotation chosen in Screens is applied
  /// within one health interval.
  private func readScreens() {
    var byServer: [String: [Runtime]] = [:]
    for key in order {
      if let rt = runtimes[key], rt.sink != nil, rt.page.isBound, let server = rt.serverURL { byServer[server, default: []].append(rt) }
    }
    for (server, outputs) in byServer {
      Task { @MainActor in
        do {
          let screens = try await HealthReporter.screens(server: server)
          for rt in outputs { self.applyScreen(rt, from: screens) }
        } catch {
          // The text, not the error value: it carries addresses and task ids that differ
          // each time, and the same trouble must read as the same trouble.
          let why = (error as? ScreenList.ReadError)?.description ?? error.localizedDescription
          for rt in outputs { self.screenReadFailed(rt, why) }
        }
        self.refresh()
      }
    }
  }

  private func applyScreen(_ rt: Runtime, from screens: [ScreenRecord]) {
    guard let sink = rt.sink, case .bound(let ref) = rt.page else { return }
    let port = rt.descriptor.port
    guard let screen = ScreenList.find(ref, in: screens) else {
      screenReadFailed(rt, "the server lists no screen called \(ref)")
      return
    }
    if rt.screenReadProblem != nil {
      Log.notice(.output, "\(port): the screen's name and rotation can be read again")
      rt.screenReadProblem = nil
    }
    rt.boundScreenName = screen.name
    if let card = sink as? CardOutput, (screen.videoMode ?? VideoModes.defaultMode) != (rt.videoMode ?? VideoModes.defaultMode) {
      Log.notice(.output, "\(port): format \(rt.videoMode ?? VideoModes.defaultMode) -> \(screen.videoMode ?? VideoModes.defaultMode), from \(screen.name)")
      rt.videoMode = screen.videoMode
      card.setVideoMode(screen.videoMode)
    }
    if screen.rotation != rt.rotation {
      Log.notice(.output, "\(port): rotation \(rt.rotation.rawValue) -> \(screen.rotation.rawValue) degrees, from \(screen.name)")
      rt.rotation = screen.rotation
      sink.setRotation(screen.rotation)
    }
  }

  private func screenReadFailed(_ rt: Runtime, _ why: String) {
    if rt.screenReadProblem != why {
      Log.error(.output, "\(rt.descriptor.port): could not read the screen's name and rotation: \(why)")
    }
    rt.screenReadProblem = why
  }

  // MARK: Health

  private func healthTick() {
    readScreens()
    let now = Date()
    for key in order {
      guard let rt = runtimes[key], let sink = rt.sink else { continue }
      let sample = sink.takeHealthSample()
      rt.fps = sample.fps
      guard rt.showingBound, healthBoard.isDue(key, at: now), let server = rt.serverURL,
        let token = store.record(for: key)?.token,
        let request = HealthPost.request(
          server: server, deviceId: deviceId(rt), token: token, body: HealthPost.body(sample, at: now))
      else { continue }
      Task { @MainActor in
        let outcome = await HealthReporter.post(request)
        self.healthResult(key, rt, outcome)
      }
    }
    refresh()
  }

  private func healthResult(_ key: String, _ rt: Runtime, _ outcome: HealthOutcome) {
    let port = rt.descriptor.port
    switch healthBoard.record(outcome, for: key, at: Date()) {
    case .none:
      break
    case .recovered:
      Log.notice(.health, "\(port): health posts are accepted again")
    case .paused(let status, let retryIn):
      Log.notice(.health, "\(port): the server does not recognise this output (HTTP \(status): released in Screens, not set up, or a token it does not hold); health posts for this output are paused, retried in \(Int(retryIn)) s or when it is set up again; reloading its page so it shows what the server now says")
      // The page on screen is from before the server stopped recognising this output
      // (a release leaves a set-up screen up), and a screen set up again only pins the
      // output's token when the output asks at /enroll. Asking again is how it learns
      // it is on the holding screen, and how it is set up again.
      rt.sink?.surface.reload()
    case .failing(let why):
      Log.error(.health, "\(port): \(why)")
    case .rediscover(let misses):
      // The server stopped answering: find it again, unless a file says where it is.
      if identity.server == nil {
        Log.notice(.discovery, "\(port): \(misses) health posts failed in a row; searching for the server again")
        rt.discovery?.restart()
      }
    }
    refresh()
  }

  private func noteSaveFailure(_ error: Error) {
    let text = "Output settings could not be saved: \(error.localizedDescription)"
    // The same cause again (every display change retries) is not a new line.
    if noteTable["state-save"] != text { Log.error(.state, "could not save outputs.json: \(error.localizedDescription)") }
    setNote("state-save", text)
  }

  // MARK: Local Network

  private func suspectLocalNetwork() {
    if noteTable["local-network"] == nil {
      Log.error(.app, "Local Network access may be off for this app")
    }
    setNote("local-network", LocalNetworkAccess.windowMessage)
  }

  private func clearLocalNetworkSuspicion() {
    if noteTable["local-network"] != nil {
      Log.notice(.app, "the network is reachable again; the Local Network warning is cleared")
      clearNote("local-network")
    }
  }

  // MARK: Window state

  private func setNote(_ cause: String, _ text: String) {
    noteTable[cause] = text
    notes = noteTable.sorted { $0.key < $1.key }.map(\.value)
  }

  private func clearNote(_ cause: String) {
    noteTable[cause] = nil
    notes = noteTable.sorted { $0.key < $1.key }.map(\.value)
  }

  private func refresh() {
    rows = order.compactMap { key in
      guard let rt = runtimes[key], let record = store.record(for: key) else { return nil }
      let d = rt.descriptor
      let status = StatusText.outputLine(
        .init(
          enabled: record.enabled, isMain: d.isMain, serverKnown: rt.serverURL != nil,
          unreachable: rt.unreachable, boundScreenName: rt.boundScreenName, showingBound: rt.showingBound,
          fps: rt.fps, healthPaused: healthBoard.isPaused(key), portProblem: (rt.sink as? CardOutput)?.problem))
      return OutputRow(id: key, title: d.isMain ? "\(d.name) (main)" : d.name, enabled: record.enabled, status: status)
    }
    connection = StatusText.connection(
      order.compactMap { runtimes[$0] }.map {
        .init(active: $0.sink != nil, serverURL: $0.serverURL, serverName: $0.serverName, loaded: $0.loaded, unreachable: $0.unreachable)
      })
  }

  // MARK: Open at login

  func setLaunchAtLogin(_ on: Bool) {
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
      launchAtLoginError = nil
      Log.notice(.app, "open at login: \(on ? "on" : "off")")
    } catch {
      launchAtLoginError = error.localizedDescription
      Log.error(.app, "could not turn open at login \(on ? "on" : "off"): \(error.localizedDescription)")
    }
    launchAtLogin = SMAppService.mainApp.status == .enabled
  }

  // MARK: Debug: --dump-frames

  private func startDumping() {
    guard let dir = options.dumpFramesDir else { return }
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
      Log.error(.app, "cannot create the frame dump folder \(dir.path): \(error.localizedDescription)")
      setNote("dump", "--dump-frames: cannot create \(dir.path)")
      return
    }
    Log.notice(.app, "writing a frame of every output to \(dir.path) every \(Int(Options.dumpInterval)) s")
    Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.dumpFrames(to: dir) }
    }
    dumpTimer = Timer.scheduledTimer(withTimeInterval: Options.dumpInterval, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.dumpFrames(to: dir) }
    }
  }

  private func dumpFrames(to dir: URL) {
    dumpSequence += 1
    let n = String(format: "%04d", dumpSequence)
    for key in order {
      guard let sink = runtimes[key]?.sink else { continue }
      sink.writeSnapshot(to: dir.appendingPathComponent("\(key)-\(n).png")) { problem in
        if let problem { Log.error(.output, "frame dump: \(problem)") }
      }
    }
    WindowSnapshot.write(model: self, to: dir.appendingPathComponent("window-\(n).png"))
  }
}
