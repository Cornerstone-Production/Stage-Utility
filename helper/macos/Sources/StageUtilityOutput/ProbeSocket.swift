import Darwin
import Foundation

/// One UDP socket for one output's probes: send to every interface's broadcast
/// address, hear the server's unicast answer on the same socket.
///
/// BSD sockets rather than Network.framework, which has no clean way to send a
/// directed broadcast. One socket per output, because the reply carries no id: the
/// socket it arrives on is how an answer is matched to the output that asked.
final class ProbeSocket {
  private var fd: Int32 = -1
  private var source: DispatchSourceRead?
  /// Called on the main queue with each datagram that arrives.
  var onDatagram: ((Data) -> Void)?

  init() throws {
    fd = socket(AF_INET, SOCK_DGRAM, 0)
    guard fd >= 0 else { throw ProbeSocketError.system("socket", errno) }
    var on: Int32 = 1
    guard setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &on, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
      let e = errno
      Darwin.close(fd)
      throw ProbeSocketError.system("SO_BROADCAST", e)
    }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = INADDR_ANY.bigEndian
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard bound == 0 else {
      let e = errno
      Darwin.close(fd)
      throw ProbeSocketError.system("bind", e)
    }
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    let s = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
    s.setEventHandler { [weak self] in self?.drain() }
    s.resume()
    source = s
  }

  deinit { close() }

  func close() {
    source?.cancel()
    source = nil
    if fd >= 0 {
      Darwin.close(fd)
      fd = -1
    }
  }

  private func drain() {
    var buffer = [UInt8](repeating: 0, count: 4096)
    while fd >= 0 {
      let n = recv(fd, &buffer, buffer.count, 0)
      if n <= 0 { return }
      onDatagram?(Data(buffer[0..<n]))
    }
  }

  /// Send `data` to each target; returns the targets that failed, with errno.
  @discardableResult
  func send(_ data: Data, to targets: [BroadcastTarget], port: UInt16) -> [(target: String, errno: Int32)] {
    var failures: [(target: String, errno: Int32)] = []
    for target in targets {
      var addr = sockaddr_in()
      addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      addr.sin_family = sa_family_t(AF_INET)
      addr.sin_port = port.bigEndian
      addr.sin_addr = target.address
      let sent = data.withUnsafeBytes { bytes in
        withUnsafePointer(to: &addr) {
          $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            sendto(fd, bytes.baseAddress, data.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
          }
        }
      }
      if sent < 0 { failures.append((target.label, errno)) }
    }
    return failures
  }
}

enum ProbeSocketError: Error, CustomStringConvertible {
  case system(String, Int32)
  var description: String {
    switch self {
    case .system(let what, let code): return "\(what) failed: \(String(cString: strerror(code)))"
    }
  }
}

/// Somewhere to broadcast to.
struct BroadcastTarget: Equatable {
  var address: in_addr
  var label: String

  static func == (a: BroadcastTarget, b: BroadcastTarget) -> Bool { a.address.s_addr == b.address.s_addr }

  /// Each up, non-loopback interface's own broadcast address: what actually leaves a
  /// Mac through the interface it names, and what covers a Mac on wired plus
  /// wifi. With none found (no network at all) the limited broadcast and loopback,
  /// so a server on this same Mac still hears the probe.
  static func current() -> [BroadcastTarget] {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return fallback }
    defer { freeifaddrs(list) }
    var found: [BroadcastTarget] = []
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let ifa = cursor {
      defer { cursor = ifa.pointee.ifa_next }
      let flags = Int32(ifa.pointee.ifa_flags)
      guard flags & IFF_UP != 0, flags & IFF_BROADCAST != 0, flags & IFF_LOOPBACK == 0,
        let dst = ifa.pointee.ifa_dstaddr, dst.pointee.sa_family == sa_family_t(AF_INET)
      else { continue }
      let sin = dst.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
      let target = BroadcastTarget(address: sin.sin_addr, label: "\(String(cString: ifa.pointee.ifa_name)) \(text(sin.sin_addr))")
      if !found.contains(target) { found.append(target) }
    }
    return found.isEmpty ? fallback : found
  }

  private static var fallback: [BroadcastTarget] {
    [
      BroadcastTarget(address: in_addr(s_addr: INADDR_BROADCAST.bigEndian), label: "255.255.255.255"),
      BroadcastTarget(address: in_addr(s_addr: INADDR_LOOPBACK.bigEndian), label: "127.0.0.1"),
    ]
  }

  private static func text(_ a: in_addr) -> String {
    var a = a
    var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
    inet_ntop(AF_INET, &a, &buf, socklen_t(INET_ADDRSTRLEN))
    return String(cString: buf)
  }
}

/// The Mac's hardware addresses, for the probe's `macs`: every up non-loopback
/// interface with a link-layer address, Ethernet-style `en*` first (the server keeps
/// the first eight), lower-case and colon-separated like the shell agent's.
enum HardwareAddresses {
  static func current() -> [String] {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return [] }
    defer { freeifaddrs(list) }
    var found: [(name: String, mac: String)] = []
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let ifa = cursor {
      defer { cursor = ifa.pointee.ifa_next }
      let flags = Int32(ifa.pointee.ifa_flags)
      guard flags & IFF_LOOPBACK == 0, let addr = ifa.pointee.ifa_addr, addr.pointee.sa_family == sa_family_t(AF_LINK) else { continue }
      let name = String(cString: ifa.pointee.ifa_name)
      let mac: String? = addr.withMemoryRebound(to: sockaddr_dl.self, capacity: 1) { dl in
        guard dl.pointee.sdl_alen == 6 else { return nil }
        let base = UnsafeRawPointer(dl).advanced(by: MemoryLayout<sockaddr_dl>.offset(of: \.sdl_data)! + Int(dl.pointee.sdl_nlen))
        return (0..<6).map { String(format: "%02x", base.load(fromByteOffset: $0, as: UInt8.self)) }.joined(separator: ":")
      }
      if let mac, mac != "00:00:00:00:00:00", !found.contains(where: { $0.mac == mac }) { found.append((name, mac)) }
    }
    return found.sorted { ($0.name.hasPrefix("en") ? 0 : 1) < ($1.name.hasPrefix("en") ? 0 : 1) }.map { $0.mac }
  }
}
