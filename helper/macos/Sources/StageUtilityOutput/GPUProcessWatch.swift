import Darwin
import Foundation
import StageUtilityOutputCore

/// Logs Chromium's GPU process ending. CEF reports a renderer that ends (each
/// output's page logs that itself) but nothing for the GPU process, which every
/// output draws through. Chromium starts another by itself; what an operator sees in
/// the meantime is outputs that stop drawing, so the log has to say why.
///
/// Every 10 s it looks for the app's child process started with
/// `--type=gpu-process` and watches it for exit. It is found by its arguments, not
/// its path: CEF 154 runs the GPU process from the plain helper app, not the
/// "(GPU)" one.
@MainActor
final class GPUProcessWatch {
  private var timer: Timer?
  private var watched: [pid_t: DispatchSourceProcess] = [:]

  func start() {
    look()
    timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.look() }
    }
  }

  /// The app is quitting: the GPU process ending now is expected.
  func stop() {
    timer?.invalidate()
    timer = nil
    for source in watched.values { source.cancel() }
    watched = [:]
  }

  private func look() {
    for pid in GPUProcessWatch.gpuChildren() where watched[pid] == nil {
      let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
      source.setEventHandler { [weak self] in
        MainActor.assumeIsolated {
          Log.error(
            .cef,
            "Chromium's GPU process (pid \(pid)) ended; Chromium starts another, and a card output that draws nothing for 5 s is reloaded")
          self?.watched[pid]?.cancel()
          self?.watched[pid] = nil
        }
      }
      watched[pid] = source
      source.resume()
      Log.notice(.cef, "watching Chromium's GPU process, pid \(pid)")
    }
  }

  private static func gpuChildren() -> [pid_t] {
    var pids = [pid_t](repeating: 0, count: 256)
    let returned = proc_listchildpids(getpid(), &pids, Int32(pids.count * MemoryLayout<pid_t>.size))
    let count = ProcessArguments.childCount(returned: returned, capacity: pids.count)
    return pids.prefix(count).filter { $0 > 0 && ProcessArguments.isGPUProcess(arguments(of: $0)) }
  }

  /// A process's arguments, empty when they cannot be read (`ProcessArguments`).
  private static func arguments(of pid: pid_t) -> [String] {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return [] }
    var buffer = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return [] }
    return ProcessArguments.parse(procargs2: Array(buffer.prefix(size)))
  }
}
