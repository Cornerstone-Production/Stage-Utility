import Testing
@testable import StageUtilityOutputCore

@Suite struct CardLayoutTests {
  static let hd = PixelSize(width: 1920, height: 1080)
  static let p720 = PixelSize(width: 1280, height: 720)

  /// The page follows the port's frame size each time the port opens, turned for a
  /// quarter turn, and is laid out again only when that changes its size.
  @Test func thePageFollowsEachOpeningAndTheTurn() {
    var layout = CardPageLayout(pageMadeAt: Self.hd)
    #expect(layout.portOpened(Self.hd) == nil)  // made at that size already
    #expect(layout.turned(.clockwise90) == PixelSize(width: 1080, height: 1920))
    #expect(layout.turned(.clockwise270) == nil)  // portrait either way
    #expect(layout.portOpened(Self.p720) == PixelSize(width: 720, height: 1280))  // a new format, still turned
    #expect(layout.turned(.clockwise180) == Self.p720)
    #expect(layout.portOpened(Self.p720) == nil)  // a retry in the same format
  }

  /// A turn before the port has opened has no frame size to turn: it is kept, and
  /// applied when the port opens, however late.
  @Test func aTurnBeforeThePortOpensIsAppliedWhenItDoes() {
    var layout = CardPageLayout(pageMadeAt: Self.hd)
    #expect(layout.turned(.clockwise90) == nil)
    #expect(layout.frame == nil)
    #expect(layout.portOpened(Self.hd) == PixelSize(width: 1080, height: 1920))
  }
}
