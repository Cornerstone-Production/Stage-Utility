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
    // Blackmagic's DeckLink SDK, vendored: the headers, and the dispatch that loads
    // the user's Desktop Video driver at run time. See Vendor/DeckLink/README.md.
    .target(
      name: "DeckLinkSDK",
      path: "Vendor/DeckLink",
      exclude: ["README.md"],
      sources: ["DeckLinkAPIDispatch.cpp"],
      publicHeadersPath: "."
    ),
    // The C API Swift calls: ports, modes, scheduled playback, and the software
    // clock that runs the same scheduler without a card.
    .target(
      name: "DeckLinkShim",
      dependencies: ["DeckLinkSDK"],
      linkerSettings: [.linkedFramework("CoreFoundation")]
    ),
    // DeckLink outputs in Swift: the driver, the ports, an output port that pulls
    // frames on the card's clock, and the Metal conversion to UYVY.
    .target(
      name: "DeckLinkKit",
      dependencies: ["DeckLinkShim", "StageUtilityOutputCore"],
      linkerSettings: [.linkedFramework("Metal"), .linkedFramework("IOSurface")]
    ),
    // A bench tool: list the ports, or play bars out of one (or a software clock)
    // through the whole path. `swift run DeckLinkProbe`.
    .executableTarget(
      name: "DeckLinkProbe",
      dependencies: ["DeckLinkKit", "StageUtilityOutputCore"]
    ),
    .testTarget(
      name: "DeckLinkKitTests",
      dependencies: ["DeckLinkKit", "DeckLinkShim", "StageUtilityOutputCore"]
    ),
  ],
  swiftLanguageVersions: [.v5]
)
