// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "StageUtilityOutput",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "StageUtilityOutput", targets: ["StageUtilityOutput"]),
  ],
  targets: [
    // Everything that can be decided without a window: the wire format, ids,
    // state files, URLs, backoff. Foundation only, so it tests without AppKit.
    .target(name: "StageUtilityOutputCore"),
    // The browser host's C API, and the few lines that open the host at run time.
    // The host itself (CEFHost/, over CEF) is built by CMake and is not linked, so
    // this package builds and tests with no CEF on the machine.
    .target(name: "StageUtilityCEFHostAPI"),
    .executableTarget(
      name: "StageUtilityOutput",
      dependencies: ["StageUtilityOutputCore", "StageUtilityCEFHostAPI"]
    ),
    .testTarget(
      name: "StageUtilityOutputCoreTests",
      dependencies: ["StageUtilityOutputCore"]
    ),
  ],
  swiftLanguageVersions: [.v5]
)
