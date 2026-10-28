import Foundation

/// Reading another process's arguments and children, as `GPUProcessWatch` does to
/// find Chromium's GPU process: the parsing, kept apart from the system calls.
public enum ProcessArguments {
  /// The arguments in a `KERN_PROCARGS2` buffer: argc as a 32-bit integer, the
  /// executable's path, NUL padding, then argc NUL-terminated strings. Fewer when
  /// the buffer ends first; empty when it is too short to hold argc.
  public static func parse(procargs2 buffer: [UInt8]) -> [String] {
    let size = buffer.count
    guard size > MemoryLayout<Int32>.size else { return [] }
    let argc = buffer.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    var i = MemoryLayout<Int32>.size
    while i < size && buffer[i] != 0 { i += 1 }  // the executable path
    while i < size && buffer[i] == 0 { i += 1 }  // its padding
    var args: [String] = []
    while args.count < argc && i < size {
      let start = i
      while i < size && buffer[i] != 0 { i += 1 }
      args.append(String(decoding: buffer[start..<i], as: UTF8.self))
      i += 1
    }
    return args
  }

  /// How many pids `proc_listchildpids` wrote into a buffer of `capacity` pids, from
  /// what it returned: a count of pids on macOS, despite the name of its size
  /// argument, or bytes as its header says. Whichever reading fits the buffer.
  public static func childCount(returned: Int32, capacity: Int) -> Int {
    guard returned > 0 else { return 0 }
    let n = Int(returned)
    return n <= capacity ? n : min(capacity, n / MemoryLayout<pid_t>.size)
  }

  /// Chromium's GPU process, by its arguments: CEF 154 runs it from the plain helper
  /// app, not the "(GPU)" one, so its path does not say.
  public static func isGPUProcess(_ arguments: [String]) -> Bool { arguments.contains("--type=gpu-process") }

  /// Chromium's network service, when it runs in a process of its own: a utility
  /// process started for `network.mojom.NetworkService`.
  public static func isNetworkServiceProcess(_ arguments: [String]) -> Bool {
    arguments.contains("--utility-sub-type=network.mojom.NetworkService")
  }
}
