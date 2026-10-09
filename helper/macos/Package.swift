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
    .executableTarget(
      name: "StageUtilityOutput",
      dependencies: ["StageUtilityOutputCore"]
    ),
    .testTarget(
      name: "StageUtilityOutputCoreTests",
      dependencies: ["StageUtilityOutputCore"]
    ),
  ],
  swiftLanguageVersions: [.v5]
)
