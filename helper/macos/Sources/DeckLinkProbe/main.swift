// A bench tool for the DeckLink layer, without the helper around it.
//
//   swift run DeckLinkProbe list
//       The driver's state, and every port that can play out with the modes the
//       helper can send on it.
//   swift run DeckLinkProbe bars <output key> [mode] [seconds]
//       75% colour bars with a white line crossing them, out of one port, through
//       the same path a screen takes: a picture presented as an IOSurface, the
//       Metal conversion into the card's frame, the card's clock asking for each
//       frame. Prints the counts every second.
//   swift run DeckLinkProbe null [seconds] [outputs]
//       The same on the software clock instead of a card, at 1920 x 1080 59.94.
//
//   --helper-frames, with bars or null, sends in frames of the helper's own memory
//   instead of frames the card makes: the kind a port falls back to when its card
//   will not make frames.
//   --head-start <ms> and --fill-lead <ms> set when each slot's picture is asked
//   for and when the slot is filled, before it goes to air (DECKLINK.md, "Latency").
//
// Each picture is drawn when the clock asks for it, on another thread, as a
// windowless browser's begin frame would be: a picture that is not ready by the
// fill shows up as a repeat. At the end it prints where the delay went, from each
// picture being drawn to its slot going out of the card.

import DeckLinkKit
import Foundation
import IOSurface
import StageUtilityOutputCore

/// Draws the bars into an IOSurface and moves a white line across them.
final class BarsPainter {
  let width: Int
  let height: Int
  let surface: IOSurfaceRef
  private var line = -1

  private static let bars: [(UInt8, UInt8, UInt8)] = [
    (191, 191, 191), (191, 191, 0), (0, 191, 191), (0, 191, 0), (191, 0, 191), (191, 0, 0), (0, 0, 191),
  ]

  init(width: Int, height: Int) {
    self.width = width
    self.height = height
    let properties: [String: Any] = [
      kIOSurfaceWidth as String: width, kIOSurfaceHeight as String: height,
      kIOSurfaceBytesPerElement as String: 4, kIOSurfacePixelFormat as String: 0x4247_5241,
    ]
    surface = IOSurfaceCreate(properties as CFDictionary)!
    for x in 0..<width { paintColumn(x, white: false) }
  }

  /// Move the line to where frame `index` puts it.
  func draw(frame index: Int64) {
    let x = Int(index % Int64(width / 4)) * 4
    if line >= 0 { for dx in 0..<4 { paintColumn(line + dx, white: false) } }
    for dx in 0..<4 { paintColumn(x + dx, white: true) }
    line = x
  }

  private func paintColumn(_ x: Int, white: Bool) {
    let bar = Self.bars[min(Self.bars.count - 1, x * Self.bars.count / width)]
    let (r, g, b) = white ? (255, 255, 255) : bar
    IOSurfaceLock(surface, [], nil)
    let base = IOSurfaceGetBaseAddress(surface)
    let rowBytes = IOSurfaceGetBytesPerRow(surface)
    for y in 0..<height {
      let at = base + y * rowBytes + x * 4
      at.storeBytes(of: UInt32(b) | UInt32(g) << 8 | UInt32(r) << 16 | 0xff00_0000, as: UInt32.self)
    }
    IOSurfaceUnlock(surface, [], nil)
  }
}

/// A source that times its fills, around the real one.
final class TimedSource: CardFrameSource {
  let inner: SurfaceFrameSource
  private let lock = NSLock()
  private var fills = 0
  private var total: Double = 0
  private var worst: Double = 0

  init(_ inner: SurfaceFrameSource) { self.inner = inner }

  func begin(_ request: CardFrameRequest) { inner.begin(request) }

  func fill(_ request: CardFrameRequest, into target: CardFrameTarget) -> CardPicture? {
    let start = DispatchTime.now().uptimeNanoseconds
    let filled = inner.fill(request, into: target)
    let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
    if filled != nil {
      lock.withLock {
        fills += 1
        total += ms
        worst = max(worst, ms)
      }
    }
    return filled
  }

  var summary: String {
    lock.withLock {
      fills == 0
        ? "no frames filled"
        : String(format: "%d frames filled, %.2f ms each on average, %.2f ms at worst", fills, total / Double(fills), worst)
    }
  }
}

/// The pictures go out from the first begin frame: the source learns the frame size
/// from the port's pre-roll, which goes out black.
func feed(_ source: SurfaceFrameSource, painter: BarsPainter, label: String) -> DispatchQueue {
  let render = DispatchQueue(label: "render \(label)", qos: .userInteractive)
  source.onBeginFrame = { request in
    render.async {
      let drawn = DispatchTime.now().uptimeNanoseconds
      painter.draw(frame: request.index)
      do { try source.present(painter.surface, contentNs: drawn) } catch { print("\(label): could not present: \(error)") }
    }
  }
  return render
}

/// Every slot's timing, from each port's once-a-second collection.
final class TimingLog {
  private let lock = NSLock()
  private var all: [FrameTiming] = []
  func add(_ batch: [FrameTiming]) { lock.withLock { all.append(contentsOf: batch) } }
  var timings: [FrameTiming] { lock.withLock { all } }
}

func describe(_ name: String, _ d: Distribution?) -> String {
  guard let d else { return "  \(name): none" }
  return "  " + name.padding(toLength: 26, withPad: " ", startingAt: 0)
    + String(format: "p50 %6.2f  p95 %6.2f  max %6.2f ms  (%d)", d.p50, d.p95, d.max, d.count)
}

func printBreakdown(_ label: String, _ timings: [FrameTiming]) {
  if let path = ProcessInfo.processInfo.environment["DECKLINK_PROBE_CSV"] {
    let text = ([FrameTimingCSV.header] + timings.map { FrameTimingCSV.line(output: label, $0) }).joined(separator: "\n")
    do {
      try text.write(toFile: path, atomically: true, encoding: .utf8)
    } catch {
      print("could not write \(path): \(error.localizedDescription)")
    }
  }
  let b = LatencyBreakdown.of(timings)
  print("\(label): render to air, over the new pictures that went out")
  print(describe("drawn to air", b.renderToAir))
  print(describe("drawn to handed over", b.contentToPaint))
  print(describe("handed over to ready", b.paintToReady))
  print(describe("ready to filled", b.readyToFill))
  print(describe("filled to copied", b.fillToCopied))
  print(describe("copied to card", b.copiedToScheduled))
  print(describe("card to air", b.scheduledToAir))
  print(describe("air to completed", b.airToCompleted))
}

func run(_ ports: [(DeckLinkOutputPort, TimedSource)], seconds: Double) {
  let logs = ports.map { (port, _) -> TimingLog in
    let log = TimingLog()
    port.onTimings = { log.add($0) }
    return log
  }
  let end = Date().addingTimeInterval(seconds)
  while Date() < end {
    Thread.sleep(forTimeInterval: 1)
    for (port, _) in ports {
      let c = port.counters
      print("\(port.label): \(port.state)  scheduled \(c.scheduled)  rendered \(c.rendered)  repeated \(c.repeated)  dropped \(c.dropped)  resyncs \(c.resyncs)  skipped \(c.skipped)")
    }
  }
  for ((port, timed), log) in zip(ports, logs) {
    port.close()
    print("\(port.label): \(timed.summary)")
    printBreakdown(port.label, log.timings)
  }
}

func printLog(_ level: DeckLinkLog.Level, _ message: String) {
  DeckLinkLog.write(level, message)
  print("[decklink] \(message)")
}

var frames = DeckLinkOutputPort.Frames.card
var leads = CardLeads.standard
var args: [String] = []
var rest = Array(CommandLine.arguments.dropFirst())
while !rest.isEmpty {
  let arg = rest.removeFirst()
  switch arg {
  case "--helper-frames": frames = .helper
  case "--head-start" where !rest.isEmpty: leads.headStartMs = Double(rest.removeFirst()) ?? leads.headStartMs
  case "--fill-lead" where !rest.isEmpty: leads.fillLeadMs = Double(rest.removeFirst()) ?? leads.fillLeadMs
  default: args.append(arg)
  }
}

switch args.first {
case "list":
  let started = DispatchTime.now().uptimeNanoseconds
  _ = DeckLinkDriver.ports()
  print(String(format: "a scan of the ports took %.1f ms", Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6))
  let status = DeckLinkDriver.status()
  print("Desktop Video: \(status)")
  if let problem = status.problem { print(problem) }
  for port in DeckLinkDriver.ports() {
    let d = port.descriptor
    print("\(d.key)  \(d.name)  model \(port.modelName)")
    print("  sends: \((d.modes ?? []).joined(separator: ", "))")
    for m in port.modes {
      print("  \(m.driverName): \(m.width)x\(m.height) \(m.frameDuration)/\(m.timeScale) \(m.field) yuv8 \(m.supportsYUV8)")
    }
  }

case "bars" where args.count >= 2:
  let status = DeckLinkDriver.status()
  if let problem = status.problem {
    print(problem)
    exit(1)
  }
  guard let found = DeckLinkDriver.ports().first(where: { $0.id.outputKey == args[1] }) else {
    print("no port \(args[1]); run `list` for the keys")
    exit(1)
  }
  let mode = args.count >= 3 ? args[2] : nil
  let modeSize = VideoModes.resolve(mode, among: found.modes)
  guard case .success(let cardMode) = modeSize else {
    if case .failure(let why) = modeSize { print(why.reason) }
    exit(1)
  }
  let converter = try UYVYConverter()
  let source = SurfaceFrameSource(converter: converter)
  let timed = TimedSource(source)
  let painter = BarsPainter(width: cardMode.width, height: cardMode.height)
  _ = feed(source, painter: painter, label: found.descriptor.name)
  let port = DeckLinkOutputPort(
    label: found.descriptor.name, hardware: .port(found), source: timed, leads: leads, frames: frames,
    log: printLog)
  _ = DeckLinkDriver.watchDevices { port.retry() }
  port.open(videoMode: mode)
  run([(port, timed)], seconds: args.count >= 4 ? Double(args[3]) ?? 10 : 10)

case "null":
  let seconds = args.count >= 2 ? Double(args[1]) ?? 10 : 10
  let count = args.count >= 3 ? Int(args[2]) ?? 1 : 1
  let converter = try UYVYConverter()
  var ports: [(DeckLinkOutputPort, TimedSource)] = []
  for n in 1...count {
    let source = SurfaceFrameSource(converter: converter)
    let timed = TimedSource(source)
    let label = "null \(n)"
    _ = feed(source, painter: BarsPainter(width: 1920, height: 1080), label: label)
    let port = DeckLinkOutputPort(
      label: label,
      hardware: .softwareClock(width: 1920, height: 1080, frameDuration: 1001, timeScale: 60000, ticksByItself: true),
      source: timed, leads: leads, frames: frames, log: printLog)
    port.open(videoMode: nil)
    ports.append((port, timed))
  }
  run(ports, seconds: seconds)

default:
  print(
    """
    usage: DeckLinkProbe list
           DeckLinkProbe bars <output key> [mode] [seconds] [--helper-frames] [--head-start ms] [--fill-lead ms]
           DeckLinkProbe null [seconds] [outputs] [--helper-frames] [--head-start ms] [--fill-lead ms]
    """)
  exit(2)
}
