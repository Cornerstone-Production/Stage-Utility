import Darwin
import Foundation
import StageUtilityOutputCore

/// One UDP socket for one output's probes: send to every interface's broadcast
/// address (or to one server), hear the server's unicast answer on the same socket.
///
/// BSD sockets rather than Network.framework, which has no clean way to send a
/// directed broadcast. One socket per output, because the reply carries no id: the
/// socket it arrives on is how an answer is matched to the output that asked.
@MainActor
final class ProbeSocket {
  private let fd: Int32
  private let source: DispatchSourceRead
  private var closed = false
  /// Called on the main queue with each datagram that arrives.
  var onDatagram: (@MainActor (Data) -> Void)?

  init() throws {
    let fd = socket(AF_INET, SOCK_DGRAM, 0)
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
    self.fd = fd
    let s = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
    // The descriptor is closed HERE, once the source has stopped reading it. Closing
    // it right after cancel() races a read the source has already started, and a
    // descriptor number reused by something else in between would be read from.
    s.setCancelHandler { Darwin.close(fd) }
    source = s
    s.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.drain() } }
    s.resume()
  }

  deinit { source.cancel() }

  func close() {
    closed = true
    source.cancel()
  }

  private func drain() {
    var buffer = [UInt8](repeating: 0, count: 4096)
    while !closed {
      let n = recv(fd, &buffer, buffer.count, 0)
      if n <= 0 { return }
      onDatagram?(Data(buffer[0..<n]))
    }
  }

  /// Send `data` to each target; returns the targets that failed, with errno.
  func send(_ data: Data, to targets: [ProbeTarget], port: UInt16) -> [SendFailure] {
    guard !closed else { return targets.map { SendFailure(target: $0.label, errno: EBADF) } }
    var failures: [SendFailure] = []
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
      if sent < 0 { failures.append(SendFailure(target: target.label, errno: errno)) }
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

/// Somewhere to send a probe: an interface's broadcast address, or one server.
struct ProbeTarget: Equatable, Sendable {
  var address: in_addr
  var label: String

  static func == (a: ProbeTarget, b: ProbeTarget) -> Bool { a.address.s_addr == b.address.s_addr }

  /// Each up, non-loopback interface's own broadcast address: what actually leaves a
  /// Mac through the interface it names, and what covers a Mac on wired plus
  /// wifi. With none found (no network at all) the limited broadcast and loopback,
  /// so a server on this same Mac still hears the probe.
  static func broadcasts() -> [ProbeTarget] {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return fallback }
    defer { freeifaddrs(list) }
    var found: [ProbeTarget] = []
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let ifa = cursor {
      defer { cursor = ifa.pointee.ifa_next }
      let flags = Int32(ifa.pointee.ifa_flags)
      guard flags & IFF_UP != 0, flags & IFF_BROADCAST != 0, flags & IFF_LOOPBACK == 0,
        let dst = ifa.pointee.ifa_dstaddr, dst.pointee.sa_family == sa_family_t(AF_INET)
      else { continue }
      let sin = dst.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
      let target = ProbeTarget(address: sin.sin_addr, label: "\(String(cString: ifa.pointee.ifa_name)) \(text(sin.sin_addr))")
      if !found.contains(target) { found.append(target) }
    }
    return found.isEmpty ? fallback : found
  }

  /// The IPv4 address of `host`, looked up off the main thread: a name that has to be
  /// resolved (mDNS, a slow resolver) must not stall the window. `completion` is
  /// called ON the main queue; nil when it does not resolve.
  static func resolve(host: String, completion: @escaping @Sendable (ProbeTarget?) -> Void) {
    DispatchQueue.global(qos: .utility).async {
      let target = lookup(host)
      DispatchQueue.main.async { completion(target) }
    }
  }

  private static func lookup(_ host: String) -> ProbeTarget? {
    var hints = addrinfo()
    hints.ai_family = AF_INET
    hints.ai_socktype = SOCK_DGRAM
    var result: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, nil, &hints, &result) == 0, let first = result else { return nil }
    defer { freeaddrinfo(result) }
    guard let sa = first.pointee.ai_addr, sa.pointee.sa_family == sa_family_t(AF_INET) else { return nil }
    let sin = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
    return ProbeTarget(address: sin.sin_addr, label: "\(host) \(text(sin.sin_addr))")
  }

  private static var fallback: [ProbeTarget] {
    [
      ProbeTarget(address: in_addr(s_addr: INADDR_BROADCAST.bigEndian), label: "255.255.255.255"),
      ProbeTarget(address: in_addr(s_addr: INADDR_LOOPBACK.bigEndian), label: "127.0.0.1"),
    ]
  }

  private static func text(_ a: in_addr) -> String {
    var a = a
    var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
    inet_ntop(AF_INET, &a, &buf, socklen_t(INET_ADDRSTRLEN))
    return String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
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
