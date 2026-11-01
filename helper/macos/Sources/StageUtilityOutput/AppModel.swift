import AppKit
import DeckLinkKit
import ServiceManagement
import StageUtilityOutputCore
import SwiftUI

/// What the helper's window shows for one output, or for a DeckLink port that is
/// not one (`switchable` false: set as an input, nothing to turn on).
struct OutputRow: Identifiable, Equatable {
  var id: String
  var title: String
  var enabled: Bool
  var status: String
  var switchable = true
}

/// Everything the helper decides, in one place: which outputs exist, which are on,
/// where each one's server is, what each shows, and what to tell the operator.
@MainActor
final class AppModel: ObservableObject {
  @Published private(set) var rows: [OutputRow] = []
  @Published private(set) var connection: StatusText.Connection = .noOutputs
  /// Things that are wrong or worth knowing, shown under the connection line.
  @Published private(set) var notes: [String] = []
  /// What "Open at login" offers: the switch, or that the LaunchAgent
  /// starts the helper (`LoginItem`).
  @Published private(set) var loginOffer: LoginItem.Offer = .userSwitch(on: false)
  @Published private(set) var launchAtLoginError: String?
  let version: String
  /// outputs.json was there at launch: false only on a genuine first run. Asked after
  /// `start()`, `hasFile` would always say yes, as the outputs are recorded there.
  var hadStateFile: Bool { store.existedAtLoad }
  /// Called when a change in the displays leaves the menu bar covered by an output
  /// that did not cover it before: the icon is hidden, so the window has to come up.
  var onMenuBarCovered: (() -> Void)?

  private let options: Options
  private let paths: HelperPaths
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
    /// When the server last answered this output's probe.
    var answeredAt: Date?
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
    /// Counts the changes made to this output's switch in the window. A health post
    /// remembers the count it went out under, and its answer is dropped when the
    /// count has moved: it describes the value from before the change.
    var switchGeneration = 0
    /// A card output's render-to-air latency over the last health window.
    var latencyMs: Double?
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
  /// The DeckLink driver and its ports: scanned at start, on every device change
  /// and every `deckLinkRescan` seconds, logged when they change. A scan takes 20 to
  /// 45 ms on an 8K Pro, so after launch it runs off the main thread, where every
  /// card output's pictures arrive.
  private let deckLink = DeckLinkInventory(log: Log.decklink)
  private let deckLinkScans = DispatchQueue(label: "com.stageutility.output.decklink-scan", qos: .utility)
  private var deckLinkTimer: Timer?
  /// Set by `stopAll`: a scan finishing after it changes nothing.
  private var stopping = false
  /// How often the ports are looked at again: Desktop Video Setup turning a port
  /// from an input to an output sends no device notification.
  static let deckLinkRescan: TimeInterval = 10
  private var dumpTimer: Timer?
  private var dumpSequence = 0
  private var dumpLog = FrameDumpLog()

  init(options: Options, paths: HelperPaths) {
    self.options = options
    self.paths = paths
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
    if let server = identity.server { Log.notice(.discovery, "server file names \(Redact.url(server)); probes go to it alone, by unicast") }
    if let problem = store.readProblem {
      Log.error(.state, "\(problem); it is left as it is and nothing is saved until it is fixed or removed and the helper restarted")
      setNote("state-unreadable", "\(problem). Outputs keep working, but nothing is saved, and each launch makes new tokens, until it is fixed or removed and the helper restarted.")
    }
    if let problem = identity.readProblem {
      Log.error(.state, "\(problem)")
      setNote("identity-read", "\(problem). It is left as it is.")
    }
    if let why = CEFEngine.failure { setNote("cef", WebSurfaces.unavailable(why)) }
    decideLoginItem()
  }

  // MARK: Start

  func start() {
    // Before any output runs, so on this thread.
    deckLinkScanned(deckLink.scan().status)
    // On the driver's thread, for a device arriving or going. Without a driver
    // there is nothing to watch, and installing one takes a restart.
    DeckLinkDriver.watchDevices { [weak self] in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.rescanDeckLink(devicesChanged: true) } }
    }
    deckLinkTimer = Timer.scheduledTimer(withTimeInterval: AppModel.deckLinkRescan, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.rescanDeckLink(devicesChanged: false) }
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
    stopping = true
    gpuWatch.stop()
    deckLinkTimer?.invalidate()
    for key in order { deactivate(key) }
  }

  private let gpuWatch = GPUProcessWatch()

  /// Every card output's settings, from the command line.
  private lazy var cardSettings: CardOutput.Settings = {
    var settings = CardOutput.Settings()
    if let ms = options.headStartMs { settings.leads.headStartMs = ms }
    if let ms = options.fillLeadMs { settings.leads.fillLeadMs = ms }
    settings.readsLatencyStamp = options.testPattern == .latency
    if let file = options.frameTimingsFile {
      do {
        let log = try FrameTimingFile(file)
        settings.onTimings = { output, timings in log.append(output: output, timings) }
        Log.notice(.app, "writing every card output's frame timings to \(file.path)")
      } catch {
        Log.error(.app, "--frame-timings: cannot write \(file.path): \(error.localizedDescription)")
        setNote("frame-timings", "--frame-timings: cannot write \(file.path)")
      }
    }
    return settings
  }()

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

  /// Without a working driver the window says why, once, and there are simply no
  /// DeckLink outputs.
  private func deckLinkScanned(_ status: DeckLinkDriver.Status) {
    if let problem = status.problem { setNote("decklink", "\(problem).") } else { clearNote("decklink") }
  }

  /// Read the driver and its ports again, off the main thread. A device arrived
  /// or went (`devicesChanged`), or it is time to look: announce any port that can
  /// play now, list the ones set as inputs, and on a device change have every lost
  /// port try again now rather than at its next retry.
  private func rescanDeckLink(devicesChanged: Bool) {
    deckLinkScans.async { [weak self, deckLink] in
      let scan = deckLink.scan()
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, !self.stopping else { return }
          self.deckLinkScanned(scan.status)
          if scan.changed || devicesChanged { self.reconcile() }
          if devicesChanged { for key in self.order { (self.runtimes[key]?.sink as? CardOutput)?.retry() } }
        }
      }
    }
  }

  /// Make the runtimes match the displays macOS lists now, every DeckLink port
  /// found since launch, and the virtual card outputs `--virtual-sdi` asks for.
  private func reconcile() {
    // Quitting: nothing new is made in the moments before the app goes, whatever
    // asks (a display change, a device arriving, a scan finishing).
    guard !stopping else { return }
    let outputs = DisplayEnumerator.current().map(PresentOutput.init(display:))
      + deckLink.seen.map { PresentOutput(descriptor: $0.descriptor, card: .port($0)) }
      + VirtualCards.outputs(count: options.virtualSDI).map { PresentOutput(descriptor: $0, card: .virtual) }
    let present = Set(outputs.map { $0.descriptor.key })
    for key in order where !present.contains(key) {
      let name = runtimes[key]?.descriptor.port ?? key
      if deckLink.inputs.contains(where: { $0.id.outputKey == key }) {
        Log.notice(.output, "\(name) is now set as an input in Desktop Video Setup; its output is closed")
      } else {
        Log.notice(.output, "\(name) is gone; its window is closed")
      }
      deactivate(key)
      runtimes[key] = nil
    }
    order = outputs.map { $0.descriptor.key }
    for d in outputs {
      let key = d.descriptor.key
      let record = ensureRecord(d.descriptor)
      let rt: Runtime
      if let existing = runtimes[key] {
        rt = existing
        rt.output = d
        if let screen = d.screen { (rt.sink as? DisplaySink)?.follow(screen) }
      } else {
        rt = Runtime(output: d)
        runtimes[key] = rt
        Log.notice(.output, "\(d.descriptor.name) (\(d.descriptor.key)): \(record.enabled ? "on" : "off")\(d.descriptor.isMain ? ", main display" : "")")
      }
      if record.enabled, rt.sink == nil { activate(key) }
      if !record.enabled, rt.sink != nil { deactivate(key) }
      // An output that is off but set up still checks in, so Screens can switch it
      // back on: it needs the server's address, which discovery finds.
      if !record.enabled, rt.sink == nil, rt.discovery == nil, record.boundTo != nil { listen(key) }
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

  /// The switch in the window. The change is sent to the server under an id until it
  /// has taken it (`OutputSwitch`), so Screens shows it and does not undo it.
  func setEnabled(_ key: String, _ on: Bool) {
    guard let rt = runtimes[key] else { return }
    rt.switchGeneration += 1
    save { try store.setEnabledLocally(on, changeId: OutputSwitch.newChangeId(), key: key) }
    Log.notice(.output, "\(rt.descriptor.name): turned \(on ? "on" : "off") in the window")
    switchOutput(key, on)
    // Done from the window itself, which is up: nothing to pop.
    wasMenuBarCovered = menuBarCovered
    // Said at once rather than at the next health tick, so Screens shows it now.
    if !on { postOff(key, rt) }
  }

  /// The server's answer to a health post says this output should be `on`.
  private func applyFromServer(_ key: String, _ on: Bool) {
    guard let rt = runtimes[key] else { return }
    // A post still on its way was sent under the value from before this: its answer
    // must not turn the output back.
    rt.switchGeneration += 1
    save { try store.setEnabled(on, key: key) }
    Log.notice(.output, "\(rt.descriptor.name): turned \(on ? "on" : "off") by the server")
    switchOutput(key, on)
    // Nobody is at the window: if this covered the menu bar, the icon is under the
    // page, so the window comes up, as it does for a display change.
    let covered = menuBarCovered
    if HelperWindowPolicy.opensOnChange(wasCovered: wasMenuBarCovered, isCovered: covered) { onMenuBarCovered?() }
    wasMenuBarCovered = covered
  }

  /// Open or close an output to match its stored switch. An output that is off but
  /// set up goes on listening to its server.
  private func switchOutput(_ key: String, _ on: Bool) {
    if on { activate(key) } else { deactivate(key, keepListening: true) }
    refresh()
  }

  private func activate(_ key: String) {
    guard !stopping, let rt = runtimes[key], rt.sink == nil else { return }
    let d = rt.descriptor
    let sink: OutputSink
    if let screen = rt.output.screen {
      sink = DisplaySink(descriptor: d, screen: screen)
    } else if let card = rt.output.card {
      // In the format its screen last set, so it is not opened in the default first
      // and again once the screen has been read.
      rt.videoMode = store.record(for: key)?.videoMode
      let output = CardOutput(descriptor: d, hardware: card, videoMode: rt.videoMode, settings: cardSettings)
      // The port's line changes as it opens, is lost, or its page goes silent: the
      // window says so then, not at the next health tick.
      output.onProblemChange = { [weak self] in self?.refresh() }
      sink = output
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
    sink.surface.localNetworkEvidence = { [weak self, weak rt] since in
      guard let self, let rt else { return .none }
      return self.localNetworkEvidence(rt, since: since)
    }

    beginDiscovery(key, rt)
  }

  /// An output that is off but set up on a server keeps probing it, and keeps
  /// posting that it is off (`postOff`), so the server can switch it back on.
  private func listen(_ key: String) {
    guard !stopping, let rt = runtimes[key], rt.sink == nil, rt.discovery == nil else { return }
    beginDiscovery(key, rt)
  }

  private func beginDiscovery(_ key: String, _ rt: Runtime) {
    // An output that was off and set up has one running already.
    rt.discovery?.stop()
    // With a `server` file the page loads from it at once and the probes go to that
    // server alone, so the output still shows up under "Not set up yet". The latency
    // test page needs no server: it is up from the start.
    var mode = OutputDiscovery.Mode.broadcast
    if let server = identity.server {
      rt.serverURL = server
      if let host = EnrollURL.host(of: server) { mode = .unicast(host: host) }
    }
    if rt.sink != nil, rt.serverURL != nil || options.testPattern != nil { navigate(rt) }
    let d = rt.descriptor
    let discovery = OutputDiscovery(
      label: d.port, port: options.discoveryPort, mode: mode,
      boundTo: { [weak self] in self?.store.record(for: key)?.boundTo },
      makeProbe: { [weak self, weak rt] unreachable in self?.probe(for: rt, unreachable: unreachable) ?? Data() })
    discovery.onReply = { [weak self, weak rt] reply, change in
      guard let self, let rt else { return }
      self.heard(key, rt, reply, change)
    }
    discovery.onLocalNetworkSuspected = { [weak self] in self?.suspectLocalNetwork() }
    rt.discovery = discovery
    discovery.start()
  }

  /// `keepListening`: the output is switched off but stays set up on its server, so
  /// it keeps probing it and posting that it is off. Not for one that is gone or
  /// for quit.
  private func deactivate(_ key: String, keepListening: Bool = false) {
    guard let rt = runtimes[key] else { return }
    rt.discovery?.stop()
    rt.discovery = nil
    rt.sink?.stop()
    rt.sink = nil
    rt.loaded = false
    rt.unreachable = false
    rt.answeredAt = nil
    rt.page = .other
    rt.rotation = .none
    rt.videoMode = nil
    rt.screenReadProblem = nil
    rt.boundScreenName = nil
    rt.fps = nil
    rt.latencyMs = nil
    healthBoard.forget(key)
    // Switched off but set up on a server: it stays reachable from it, to be switched
    // on, so it keeps the address it has.
    let staysReachable = keepListening && (store.record(for: key).map { !$0.enabled && $0.boundTo != nil } ?? false)
    // A server from discovery is looked for again on the next turn-on; one from the
    // server file stays.
    if identity.server == nil, !staysReachable { rt.serverURL = nil }
    if staysReachable { listen(key) }
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
    return OutputRecord.deviceId(of: store.record(for: key), mac: identity.deviceId, key: key)
  }

  // MARK: Server

  private func heard(_ key: String, _ rt: Runtime, _ reply: DiscoveryReply, _ change: OutputBinding) {
    rt.serverName = reply.name
    rt.answeredAt = Date()
    clearLocalNetworkSuspicion()
    // A server file names the server; an answer from it only says it is there.
    if identity.server == nil, rt.serverURL != reply.url {
      Log.notice(.discovery, "\(rt.descriptor.port): server is \"\(reply.name)\" at \(Redact.url(reply.url))")
      rt.serverURL = reply.url
      navigate(rt)
    }
    if case .forget(let server) = change {
      Log.notice(.discovery, "\(rt.descriptor.port): \"\(reply.name)\" (\(server)) no longer has this output set up; forgot it, so any server can set it up")
    }
    save { try store.apply(change, key: key) }
    // Off and no longer set up anywhere: nothing to say, so stop probing, as an off
    // output always did.
    if rt.sink == nil, let record = store.record(for: key), !record.enabled, record.boundTo == nil {
      rt.discovery?.stop()
      rt.discovery = nil
      if identity.server == nil { rt.serverURL = nil }
    }
    refresh()
  }

  private func navigate(_ rt: Runtime) {
    if options.testPattern == .latency {
      rt.sink?.show(url: LatencyPage.url)
      return
    }
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
    let format = VideoModes.normalised(screen.videoMode)
    if let card = sink as? CardOutput, VideoModes.effective(format) != VideoModes.effective(rt.videoMode) {
      Log.notice(
        .output,
        "\(port): format \(VideoModes.effective(rt.videoMode)) -> \(VideoModes.effective(format)), from \(screen.name)")
      rt.videoMode = format
      save { try store.setVideoMode(format, key: rt.descriptor.key) }
      card.setVideoMode(format)
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
    guard !stopping else { return }
    readScreens()
    let now = Date()
    for key in order {
      guard let rt = runtimes[key] else { continue }
      guard let sink = rt.sink else {
        postOff(key, rt)
        continue
      }
      let sample = sink.takeHealthSample()
      rt.fps = sample.fps
      rt.latencyMs = sample.latencyMs
      guard rt.showingBound else { continue }
      let change = store.record(for: key)?.pendingChange
      send(key, rt, body: HealthPost.body(sample, at: now, changeId: change), change: change, at: now)
    }
    refresh()
  }

  /// An output that is switched off posts `{enabled: false}`, so that Screens sees it
  /// is off and can switch it back on. Only one that is set up on a server: any other
  /// has nobody to tell.
  private func postOff(_ key: String, _ rt: Runtime) {
    guard rt.sink == nil, let record = store.record(for: key), !record.enabled, record.boundTo != nil else { return }
    send(key, rt, body: HealthPost.offBody(changeId: record.pendingChange), change: record.pendingChange, at: Date())
  }

  /// Post one health body, if this output is due and its server is known, and act on
  /// the answer.
  private func send(_ key: String, _ rt: Runtime, body: Data, change: String?, at now: Date) {
    guard healthBoard.isDue(key, at: now), let server = rt.serverURL, let token = store.record(for: key)?.token,
      let request = HealthPost.request(server: server, deviceId: deviceId(rt), token: token, body: body)
    else { return }
    let generation = rt.switchGeneration
    Task { @MainActor in
      let reply = await HealthReporter.post(request)
      self.healthResult(key, rt, reply.outcome)
      self.switchAnswered(key, rt, reply, sentChange: change, generation: generation)
    }
  }

  /// What the answer to an accepted post says about the switch.
  private func switchAnswered(_ key: String, _ rt: Runtime, _ reply: HealthReply, sentChange: String?, generation: Int) {
    // The output this post was for, not one made since with the same key.
    guard case .accepted = reply.outcome, runtimes[key] === rt, let record = store.record(for: key) else { return }
    let decision = OutputSwitch.decide(
      held: record.enabled, answer: reply.enabled, sentChange: sentChange, stale: generation != rt.switchGeneration)
    if let id = decision.acknowledged { save { try store.acknowledgeChange(id, key: key) } }
    if let on = decision.apply { applyFromServer(key, on) }
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

  /// Make a change to the stored outputs. The change is kept in memory whether or not
  /// the file could be written; a failure is said in the window and the log.
  private func save(_ change: () throws -> Void) {
    do {
      try change()
    } catch {
      noteSaveFailure(error)
    }
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
      // The version, so a refusal that starts with an update can be told from one that
      // did not (README, "After an update").
      Log.error(.app, "Local Network access may be off for this app (version \(version))")
    }
    setNote("local-network", LocalNetworkAccess.windowMessage)
    writeStatus()
  }

  /// What says a failed load is Local Network access rather than the server being
  /// off: the server answered this output's probe after the loads began failing (an
  /// answer from before could be a server switched off since), or every broadcast
  /// was refused.
  private func localNetworkEvidence(_ rt: Runtime, since: Date) -> UnreachablePage.Evidence {
    .init(answeredAt: rt.answeredAt, failingSince: since, broadcastsBlocked: noteTable["local-network"] != nil)
  }

  private func clearLocalNetworkSuspicion() {
    if noteTable["local-network"] != nil {
      Log.notice(.app, "the network is reachable again; the Local Network warning is cleared")
      clearNote("local-network")
      writeStatus()
    }
  }

  // MARK: Window state

  private func setNote(_ cause: String, _ text: String) {
    noteTable[cause] = text
    publishNotes()
  }

  private func clearNote(_ cause: String) {
    noteTable[cause] = nil
    publishNotes()
  }

  private func publishNotes() {
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
          fps: rt.fps, healthPaused: healthBoard.isPaused(key), portProblem: (rt.sink as? CardOutput)?.problem,
          latencyMs: rt.latencyMs, testPattern: options.testPattern != nil))
      return OutputRow(id: key, title: d.isMain ? "\(d.name) (main)" : d.name, enabled: record.enabled, status: status)
    } + deckLink.inputs.map {
      OutputRow(
        id: $0.id.outputKey, title: $0.descriptor.name, enabled: false, status: StatusText.inputPortLine, switchable: false)
    }
    connection = StatusText.connection(
      order.compactMap { runtimes[$0] }.map {
        .init(active: $0.sink != nil, serverURL: $0.serverURL, serverName: $0.serverName, loaded: $0.loaded, unreachable: $0.unreachable)
      })
    writeStatus()
  }

  // MARK: The updater's status file

  /// The bytes last written, so a refresh that changed none of its facts writes
  /// nothing: refresh runs on every probe answer.
  private var lastStatus: Data?

  /// `helper-status.json`, for the updater that installed this copy (`HelperStatus`).
  private func writeStatus() {
    let status = HelperStatus(
      version: version, pid: getpid(), chromium: CEFEngine.failure == nil ? .started : .failed,
      chromiumProblem: CEFEngine.failure, localNetworkRefused: noteTable["local-network"] != nil)
    let data = status.encoded()
    guard data != lastStatus else { return }
    do {
      try PrivateFiles.makeDirectory(paths.userDir)
      try PrivateFiles.write(data, to: paths.userDir.appendingPathComponent(HelperStatus.fileName))
      lastStatus = data
      if noteTable["status-file"] != nil { clearNote("status-file") }
    } catch {
      // Said once per cause: the next refresh tries again and would say it again.
      // In the window too: without the file an automatic update cannot tell this
      // copy started, and puts the previous one back.
      let text = "Could not write \(HelperStatus.fileName) for the updater: \(error.localizedDescription)"
      if noteTable["status-file"] != text {
        Log.error(.state, text)
        setNote("status-file", text)
      }
    }
  }

  // MARK: Open at login

  /// What "Open at login" offers (`LoginItemSwitch`, core). A copy with its own
  /// state folder never makes the service, so never touches the login item.
  private var loginItem: LoginItemSwitch!

  private func decideLoginItem() {
    loginItem = LoginItemSwitch(paths: paths, makeService: { MainAppLoginItem() })
    showLoginItem()
  }

  func setLaunchAtLogin(_ on: Bool) {
    loginItem.set(on)
    showLoginItem()
  }

  private func showLoginItem() {
    if let line = loginItem.logLine {
      if line.isError { Log.error(.app, line.text) } else { Log.notice(.app, line.text) }
    }
    loginOffer = loginItem.offer
    launchAtLoginError = loginItem.error
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
      let label = sink.descriptor.port
      sink.writeSnapshot(to: dir.appendingPathComponent("\(key)-\(n).png")) { [weak self] outcome in
        switch self?.dumpLog.line(for: key, label: label, outcome) {
        case .notice(let text): Log.notice(.output, text)
        case .error(let text): Log.error(.output, text)
        case nil: break
        }
      }
    }
    WindowSnapshot.write(model: self, to: dir.appendingPathComponent("window-\(n).png"))
  }
}

/// The app's own per-user login item.
final class MainAppLoginItem: LoginItemService {
  var isEnabled: Bool { SMAppService.mainApp.status == .enabled }
  func register() throws { try SMAppService.mainApp.register() }
  func unregister() throws { try SMAppService.mainApp.unregister() }
}
