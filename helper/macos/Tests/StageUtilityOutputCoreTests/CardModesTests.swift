import Foundation
import Testing
@testable import StageUtilityOutputCore

/// A four-character DeckLink display mode code.
private func fourCC(_ s: String) -> UInt32 { s.utf8.reduce(0) { $0 << 8 | UInt32($1) } }

private func mode(
  _ code: String, _ width: Int, _ height: Int, _ duration: Int64, _ scale: Int64, _ field: FieldOrder,
  yuv8: Bool = true
) -> CardMode {
  CardMode(
    code: fourCC(code), driverName: code, width: width, height: height, frameDuration: duration, timeScale: scale,
    field: field, supportsYUV8: yuv8)
}

/// The HD modes of the DeckLink SDK's BMDDisplayMode list, with the frame timing
/// the SDK documents for each. Interlaced modes count frames, not fields.
private let sdkHDModes: [CardMode] = [
  mode("23ps", 1920, 1080, 1001, 24000, .progressive),
  mode("24ps", 1920, 1080, 1000, 24000, .progressive),
  mode("Hp25", 1920, 1080, 1000, 25000, .progressive),
  mode("Hp29", 1920, 1080, 1001, 30000, .progressive),
  mode("Hp30", 1920, 1080, 1000, 30000, .progressive),
  mode("Hp50", 1920, 1080, 1000, 50000, .progressive),
  mode("Hp59", 1920, 1080, 1001, 60000, .progressive),
  mode("Hp60", 1920, 1080, 1000, 60000, .progressive),
  mode("Hi50", 1920, 1080, 1000, 25000, .upperFirst),
  mode("Hi59", 1920, 1080, 1001, 30000, .upperFirst),
  mode("Hi60", 1920, 1080, 1000, 30000, .upperFirst),
  mode("hp50", 1280, 720, 1000, 50000, .progressive),
  mode("hp59", 1280, 720, 1001, 60000, .progressive),
  mode("hp60", 1280, 720, 1000, 60000, .progressive),
]

/// Modes a card reports that the server has no name for.
private let otherModes: [CardMode] = [
  mode("2d24", 2048, 1080, 1000, 24000, .progressive),  // 2K DCI: 1080 lines, not 1920 wide
  mode("4k59", 3840, 2160, 1001, 60000, .progressive),
  mode("ntsc", 720, 486, 1001, 30000, .lowerFirst),
  mode("Hp47", 1920, 1080, 1001, 48000, .progressive),  // 1080p47.95, not on the server's list
  mode("psf2", 1920, 1080, 1001, 24000, .segmented),
]

@Suite struct CardModesTests {
  /// Every mode the server lets a screen be set to is one of the SDK's modes, and
  /// no two SDK modes take the same name. Interlaced modes are named by their field
  /// rate: without the doubling, 1080i59.94 would be "1080i29.97" and unreachable.
  @Test func theSDKsHDModesAreExactlyTheServersList() {
    let names = sdkHDModes.compactMap(VideoModes.name(of:))
    #expect(names.count == sdkHDModes.count)
    #expect(names.sorted() == VideoModes.all.sorted())
    #expect(Set(names).count == names.count)
  }

  @Test func namesSizeScanAndRate() {
    #expect(VideoModes.name(of: sdkHDModes[6]) == "1080p59.94")
    #expect(VideoModes.name(of: sdkHDModes[0]) == "1080p23.98")
    #expect(VideoModes.name(of: sdkHDModes[9]) == "1080i59.94")
    #expect(VideoModes.name(of: sdkHDModes[12]) == "720p59.94")
    #expect(VideoModes.name(of: otherModes[3]) == "1080p47.95")
  }

  /// 2K DCI is 2048 x 1080 at 24: naming it by its lines alone would make it a
  /// second "1080p24", and the port could be opened in the wrong size.
  @Test func aModeWithNoServerNameHasNone() {
    #expect(VideoModes.name(of: otherModes[0]) == nil)
    #expect(VideoModes.name(of: otherModes[1]) == nil)
    #expect(VideoModes.name(of: otherModes[2]) == nil)
    #expect(VideoModes.name(of: otherModes[4]) == nil)
  }

  @Test func rateTextIsTwoPlacesWithoutATrailingZero() {
    #expect(VideoModes.rateText(60000.0 / 1001) == "59.94")
    #expect(VideoModes.rateText(50) == "50")
    #expect(VideoModes.rateText(59.9) == "59.9")
  }

  @Test func noModeIsTheDefault1080p5994() throws {
    let port = sdkHDModes + otherModes
    #expect(try VideoModes.resolve(nil, among: port).get().code == fourCC("Hp59"))
    #expect(try VideoModes.resolve("", among: port).get().code == fourCC("Hp59"))
    #expect(try VideoModes.resolve("1080i50", among: port).get().code == fourCC("Hi50"))
  }

  /// One reading of a screen's `videoMode` for every place that compares or opens
  /// one: whitespace and newlines around it dropped, nothing left the default. Two
  /// spellings of one format are not a change, so the port is not reopened for it.
  @Test func aFormatIsReadOneWayEverywhere() throws {
    #expect(VideoModes.normalised(" 720p59.94\n") == "720p59.94")
    #expect(VideoModes.normalised("") == nil)
    #expect(VideoModes.normalised(" \n") == nil)
    #expect(VideoModes.normalised(nil) == nil)
    #expect(VideoModes.effective(nil) == "1080p59.94")
    #expect(VideoModes.effective("\t") == "1080p59.94")
    #expect(VideoModes.effective(" 720p59.94\n") == VideoModes.effective("720p59.94"))
    let mode = try VideoModes.resolve(" 720p59.94\n", among: VideoModes.standard).get()
    #expect(VideoModes.name(of: mode) == "720p59.94")
  }

  @Test func refusesAModeTheServerDoesNotList() {
    #expect(VideoModes.resolve("2160p59.94", among: sdkHDModes) == .failure(.unknown("2160p59.94")))
    #expect(VideoModes.resolve("1080p47.95", among: otherModes) == .failure(.unknown("1080p47.95")))
  }

  @Test func refusesAModeThePortLacksAndSaysWhatItHas() {
    let interlacedOnly = sdkHDModes.filter { $0.field == .upperFirst }
    let refused = VideoModes.resolve(nil, among: interlacedOnly)
    #expect(refused == .failure(.notOnPort("1080p59.94", offered: ["1080i50", "1080i59.94", "1080i60"])))
    if case .failure(let why) = refused {
      #expect(why.reason == "the port has no 1080p59.94 (it offers 1080i50, 1080i59.94, 1080i60)")
    }
  }

  /// The port has the mode but cannot take 8-bit YUV in it: opening it would fail at
  /// the card, so it is refused here with the real reason.
  @Test func refusesAModeThePortHasOnlyInAnotherFormat() {
    let port = [mode("Hp59", 1920, 1080, 1001, 60000, .progressive, yuv8: false)]
    #expect(VideoModes.resolve("1080p59.94", among: port) == .failure(.noYUV("1080p59.94")))
    #expect(VideoModes.offered(by: port) == [])
  }

  @Test func offeredIsTheServersOrderAndOnlyItsNames() {
    let port = [sdkHDModes[12], sdkHDModes[6], sdkHDModes[0]] + otherModes
    #expect(VideoModes.offered(by: port) == ["1080p23.98", "1080p59.94", "720p59.94"])
  }

  /// A virtual port offers every mode the server lists, each with the timing a
  /// card reports for it: the SDK's own list, matched by name.
  @Test func theStandardModesAreTheServersWithTheSDKsTimings() {
    #expect(VideoModes.standard.compactMap(VideoModes.name(of:)) == VideoModes.all)
    for m in VideoModes.standard {
      let sdk = sdkHDModes.first { VideoModes.name(of: $0) == VideoModes.name(of: m) }
      #expect(sdk.map { [$0.width, $0.height, Int($0.frameDuration), Int($0.timeScale)] } == [m.width, m.height, Int(m.frameDuration), Int(m.timeScale)])
    }
    #expect(VideoModes.standardMode(named: "1080p59") == nil)
    #expect(VideoModes.standardMode(named: "4Kp60") == nil)
  }
}
