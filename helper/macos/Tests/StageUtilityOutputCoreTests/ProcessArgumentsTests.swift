import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct ProcessArgumentsTests {
  /// A KERN_PROCARGS2 buffer: argc, the executable's path, padding, the arguments,
  /// and the environment after them, which is not arguments.
  static func buffer(argc: Int32, path: String, padding: Int, _ strings: [String]) -> [UInt8] {
    var b = withUnsafeBytes(of: argc.littleEndian) { Array($0) }
    b += Array(path.utf8) + Array(repeating: 0, count: padding)
    for s in strings { b += Array(s.utf8) + [0] }
    return b
  }

  @Test func theArgumentsAreReadAfterThePathAndItsPadding() {
    let b = Self.buffer(
      argc: 3, path: "/Applications/X.app/Contents/Frameworks/X Helper.app/Contents/MacOS/X Helper", padding: 5,
      ["X Helper", "--type=gpu-process", "--enable-features=A", "HOME=/Users/op"])
    let args = ProcessArguments.parse(procargs2: b)
    #expect(args == ["X Helper", "--type=gpu-process", "--enable-features=A"])
    #expect(ProcessArguments.isGPUProcess(args))
    #expect(!ProcessArguments.isGPUProcess(["X Helper", "--type=renderer"]))
  }

  /// As CEF 154 starts it when it runs out of the app's process.
  @Test func findsANetworkServiceProcess() {
    #expect(ProcessArguments.isNetworkServiceProcess(
      ["X Helper", "--type=utility", "--utility-sub-type=network.mojom.NetworkService", "--service-sandbox-type=network"]))
    #expect(!ProcessArguments.isNetworkServiceProcess(
      ["X Helper", "--type=utility", "--utility-sub-type=storage.mojom.StorageService"]))
  }

  /// A buffer cut short gives what it holds; one too short for argc, nothing.
  @Test func aShortBufferGivesWhatItHolds() {
    let b = Self.buffer(argc: 4, path: "/bin/x", padding: 1, ["x", "--type=gpu-process"])
    #expect(ProcessArguments.parse(procargs2: b) == ["x", "--type=gpu-process"])
    #expect(ProcessArguments.parse(procargs2: [3, 0, 0]).isEmpty)
    #expect(ProcessArguments.parse(procargs2: Self.buffer(argc: 0, path: "/bin/x", padding: 1, ["x"])).isEmpty)
  }

  /// proc_listchildpids's return is read as a count of pids when it fits the
  /// buffer, and as bytes when only that does.
  @Test func theChildCountIsWhicheverReadingFitsTheBuffer() {
    #expect(ProcessArguments.childCount(returned: 5, capacity: 256) == 5)
    #expect(ProcessArguments.childCount(returned: 5 * 4 + 1000, capacity: 256) == (5 * 4 + 1000) / 4)
    #expect(ProcessArguments.childCount(returned: 4 * 1024, capacity: 256) == 256)
    #expect(ProcessArguments.childCount(returned: 0, capacity: 256) == 0)
    #expect(ProcessArguments.childCount(returned: -1, capacity: 256) == 0)
  }
}
