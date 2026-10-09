import AppKit
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

  private let options: Options
  private let identity: MacIdentity
  private let store: OutputStateStore
  private let macs: [String]
  private let hostname: String

  /// Per output, keyed by output key.
  private final class Runtime {
    var display: ConnectedDisplay
    var sink: DisplaySink?
    var discovery: OutputDiscovery?
    var serverURL: String?
    var serverName: String?
    var loaded = false
    var unreachable = false
    var showingBound = false
    var boundScreenName: String?
    var fps: Double?
    var healthFailing = false
    var healthMisses = 0
    var spiProblems: [String] = []
    init(display: ConnectedDisplay) { self.display = display }
  }
  private var runtimes: [String: Runtime] = [:]
  private var order: [String] = []

  // One note per cause, so a repeated cause does not stack.
  private var noteTable: [String: String] = [:]
  private var healthSupported = true
  private var healthTimer: Timer?
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
    if let server = identity.server { Log.notice(.discovery, "server file names \(server); discovery is skipped") }
    if let aside = store.recoveredFrom {
      Log.error(.state, "outputs.json was unreadable and was moved to \(aside.path)")
      setNote("state-recovered", "The saved output settings could not be read. They were kept as \(aside.lastPathComponent).")
    }
    launchAtLogin = SMAppService.mainApp.status == .enabled
  }

  // MARK: Start

  func start() {
    reconcile()
    NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { [weak self] _ in
      Task { @MainActor in
        Log.notice(.output, "the display arrangement changed")
        self?.reconcile()
      }
    }
    healthTimer = Timer.scheduledTimer(withTimeInterval: HealthPost.interval, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.healthTick() }
    }
    if options.dumpFramesDir != nil { startDumping() }
  }

  // MARK: Outputs

  /// Make the runtimes match the displays macOS lists now.
  private func reconcile() {
    let displays = DisplayEnumerator.current()
    let present = Set(displays.map { $0.descriptor.key })
    for key in order where !present.contains(key) {
      Log.notice(.output, "\(runtimes[key]?.display.descriptor.port ?? key) is gone; its window is closed")
      deactivate(key)
      runtimes[key] = nil
    }
    order = displays.map { $0.descriptor.key }
    for d in displays {
      let key = d.descriptor.key
      let record = ensureRecord(d.descriptor)
      if let rt = runtimes[key] {
        rt.display = d
        rt.sink?.follow(d.screen)
      } else {
        runtimes[key] = Runtime(display: d)
        Log.notice(.output, "\(d.descriptor.name) (\(d.descriptor.key)): \(record.enabled ? "on" : "off")\(d.descriptor.isMain ? ", main display" : "")")
      }
      let rt = runtimes[key]!
      if record.enabled, rt.sink == nil { activate(key) }
      if !record.enabled, rt.sink != nil { deactivate(key) }
    }
    refresh()
  }

  private func ensureRecord(_ d: OutputDescriptor) -> OutputRecord {
    do {
      return try store.ensure(key: d.key, defaultEnabled: defaultEnabled(kind: d.kind, isMain: d.isMain))
    } catch {
      // The record exists in memory with its token; only the file is behind.
      Log.error(.state, "could not save outputs.json: \(error.localizedDescription)")
      setNote("state-save", "Output settings could not be saved: \(error.localizedDescription)")
      return store.record(for: d.key)!
    }
  }

  func setEnabled(_ key: String, _ on: Bool) {
    guard runtimes[key] != nil else { return }
    do {
      try store.setEnabled(on, key: key)
    } catch {
      Log.error(.state, "could not save outputs.json: \(error.localizedDescription)")
      setNote("state-save", "Output settings could not be saved: \(error.localizedDescription)")
    }
    Log.notice(.output, "\(runtimes[key]!.display.descriptor.name): turned \(on ? "on" : "off") in the window")
    if on { activate(key) } else { deactivate(key) }
    refresh()
  }

  private func activate(_ key: String) {
    guard let rt = runtimes[key], rt.sink == nil else { return }
    let d = rt.display.descriptor
    let sink = DisplaySink(descriptor: d, screen: rt.display.screen)
    rt.sink = sink
    if !sink.keepPaintingProblems.isEmpty {
      rt.spiProblems = sink.keepPaintingProblems
      let list = sink.keepPaintingProblems.joined(separator: ", ")
      Log.error(.webkit, "\(d.port): WebKit switches missing or not taking, so this output may freeze when the screen locks or the display sleeps: \(list)")
      setNote("spi", "WebKit switches missing on this macOS: \(list). Outputs may freeze while the screen is locked or asleep.")
    }
    sink.onLoadResult = { [weak self, weak rt] failures, _ in
      guard let self, let rt else { return }
      Task { @MainActor in self.loadResult(key, rt, failures: failures) }
    }
    sink.onURLChange = { [weak self, weak rt] url in
      guard let self, let rt else { return }
      Task { @MainActor in self.pageMoved(rt, to: url) }
    }
    sink.onLocalNetworkSuspected = { [weak self] in
      Task { @MainActor in self?.suspectLocalNetwork() }
    }

    if let server = identity.server {
      rt.serverURL = server
      navigate(rt)
    } else {
      let discovery = OutputDiscovery(label: d.port, port: options.discoveryPort) { [weak self, weak rt] in
        MainActor.assumeIsolated { self?.probe(for: rt) ?? Data() }
      }
      discovery.onReply = { [weak self, weak rt] reply in
        guard let self, let rt else { return }
        self.heard(key, rt, reply)
      }
      discovery.onLocalNetworkSuspected = { [weak self] in
        Task { @MainActor in self?.suspectLocalNetwork() }
      }
      rt.discovery = discovery
      discovery.start()
    }
  }

  private func deactivate(_ key: String) {
    guard let rt = runtimes[key] else { return }
    rt.discovery?.stop()
    rt.discovery = nil
    rt.sink?.stop()
    rt.sink = nil
    rt.loaded = false
    rt.unreachable = false
    rt.showingBound = false
    rt.boundScreenName = nil
    rt.fps = nil
    // A server from discovery is looked for again on the next turn-on; one from the
    // server file stays.
    if identity.server == nil { rt.serverURL = nil }
  }

  private func probe(for rt: Runtime?) -> Data {
    guard let rt else { return Data() }
    let d = rt.display.descriptor
    let key = d.key
    return Probe(
      id: DeviceIdentity.deviceId(mac: identity.deviceId, key: key), macs: macs, hostname: hostname,
      boundTo: store.record(for: key)?.boundTo, descriptor: d
    ).encoded()
  }

  private func deviceId(_ rt: Runtime) -> String {
    DeviceIdentity.deviceId(mac: identity.deviceId, key: rt.display.descriptor.key)
  }

  // MARK: Server

  private func heard(_ key: String, _ rt: Runtime, _ reply: DiscoveryReply) {
    rt.serverName = reply.name
    clearLocalNetworkSuspicion()
    if rt.serverURL != reply.url {
      Log.notice(.discovery, "\(rt.display.descriptor.port): server is \"\(reply.name)\" at \(reply.url)")
      rt.serverURL = reply.url
      navigate(rt)
    }
    do {
      try store.setBoundTo(reply.serverId, key: key)
    } catch {
      Log.error(.state, "could not save outputs.json: \(error.localizedDescription)")
      setNote("state-save", "Output settings could not be saved: \(error.localizedDescription)")
    }
    refresh()
  }

  private func navigate(_ rt: Runtime) {
    guard let server = rt.serverURL, let token = store.record(for: rt.display.descriptor.key)?.token,
      let url = EnrollURL.make(server: server, deviceId: deviceId(rt), token: token)
    else {
      Log.error(.output, "\(rt.display.descriptor.port): no usable server address to load")
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
      if failures == Backoff.rediscoverAfterFailures, identity.server == nil {
        Log.notice(.discovery, "\(rt.display.descriptor.port): \(failures) loads failed in a row; searching for the server again")
        rt.discovery?.restart()
      }
    }
    refresh()
  }

  private func pageMoved(_ rt: Runtime, to url: URL?) {
    // A failed load clears the URL for a moment; that is not the screen being
    // released, and the load failure has its own line.
    guard let url else { return }
    let first = url.path.split(separator: "/").first.map(String.init)
    let bound = first != nil && first != "enroll"
    if bound != rt.showingBound {
      Log.notice(.output, "\(rt.display.descriptor.port): \(bound ? "claimed, showing \(first!)" : "back on the holding screen")")
    }
    rt.showingBound = bound
    if !bound { rt.boundScreenName = nil }
    refresh()
    guard bound, let first, let server = rt.serverURL else { return }
    Task { @MainActor in
      do {
        let name = try await HealthReporter.screenName(server: server, outputRef: first)
        if rt.showingBound { rt.boundScreenName = name }
      } catch {
        Log.error(.output, "\(rt.display.descriptor.port): could not read the screen's name: \(error.localizedDescription)")
      }
      self.refresh()
    }
  }

  // MARK: Health

  private func healthTick() {
    for key in order {
      guard let rt = runtimes[key], let sink = rt.sink else { continue }
      let sample = sink.takeHealthSample()
      rt.fps = sample.fps
      guard healthSupported, rt.showingBound, let server = rt.serverURL,
        let token = store.record(for: key)?.token,
        let request = HealthPost.request(
          server: server, deviceId: deviceId(rt), token: token, body: HealthPost.body(sample, at: Date()))
      else { continue }
      Task { @MainActor in
        let outcome = await HealthReporter.post(request)
        self.healthResult(rt, outcome)
      }
    }
    refresh()
  }

  private func healthResult(_ rt: Runtime, _ outcome: HealthOutcome) {
    let port = rt.display.descriptor.port
    switch outcome {
    case .accepted:
      if rt.healthFailing { Log.notice(.health, "\(port): health posts are accepted again") }
      rt.healthFailing = false
      rt.healthMisses = 0
    case .unsupported:
      if healthSupported {
        healthSupported = false
        Log.notice(.health, "the server has no health route (404); health posts are off for this run")
      }
    case .rejected(let status):
      if !rt.healthFailing { Log.error(.health, "\(port): the server refused a health post (HTTP \(status))") }
      rt.healthFailing = true
    case .unreachable(let error):
      if !rt.healthFailing { Log.error(.health, "\(port): health post failed: \(error.localizedDescription)") }
      rt.healthFailing = true
      rt.healthMisses += 1
      if LocalNetworkAccess.looksLikeDenial(error) { suspectLocalNetwork() }
      // The server stopped answering: find it again, unless a file says where it is.
      if rt.healthMisses == Backoff.rediscoverAfterFailures, identity.server == nil {
        Log.notice(.discovery, "\(port): \(rt.healthMisses) health posts failed in a row; searching for the server again")
        rt.discovery?.restart()
      }
    }
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
      let d = rt.display.descriptor
      let status = StatusText.outputLine(
        .init(
          enabled: record.enabled, isMain: d.isMain, serverKnown: rt.serverURL != nil,
          unreachable: rt.unreachable, boundScreenName: rt.boundScreenName, showingBound: rt.showingBound,
          fps: rt.fps))
      return OutputRow(id: key, title: d.isMain ? "\(d.name) (main)" : d.name, enabled: record.enabled, status: status)
    }
    let active = order.compactMap { runtimes[$0] }.filter { $0.sink != nil }
    if let bad = active.first(where: { $0.unreachable }), let url = bad.serverURL {
      connection = .unreachable(address: EnrollURL.displayAddress(url))
    } else if let good = active.first(where: { $0.serverURL != nil && ($0.loaded || $0.serverName != nil) }), let url = good.serverURL {
      connection = .connected(name: good.serverName ?? "Stage Utility", address: EnrollURL.displayAddress(url))
    } else if let any = active.first(where: { $0.serverURL != nil }), let url = any.serverURL {
      connection = .configured(address: EnrollURL.displayAddress(url))
    } else if active.isEmpty {
      connection = .noOutputs
    } else {
      connection = .searching
    }
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
    let first = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
      Task { @MainActor in self?.dumpFrames(to: dir) }
    }
    _ = first
    dumpTimer = Timer.scheduledTimer(withTimeInterval: Options.dumpInterval, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.dumpFrames(to: dir) }
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
