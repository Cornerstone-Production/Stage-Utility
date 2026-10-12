import Testing
@testable import StageUtilityOutputCore

@Suite struct FrameDumpLogTests {
  /// A still page has nothing new to dump every 5 s. That is said once, as a
  /// notice, when it starts, and again only after the page has drawn and gone
  /// quiet again; it is never an error.
  @Test func aStillPageIsSaidOnceNotEveryDump() {
    var log = FrameDumpLog()
    let quiet = "SDI 1: frame dump: no new frame since the last dump; the next is written when the page draws"
    #expect(log.line(for: "k", label: "SDI 1", .noNewFrame) == .notice(quiet))
    #expect(log.line(for: "k", label: "SDI 1", .noNewFrame) == nil)
    #expect(log.line(for: "k", label: "SDI 1", .noNewFrame) == nil)
    #expect(log.line(for: "k", label: "SDI 1", .written) == nil)
    #expect(log.line(for: "k", label: "SDI 1", .noNewFrame) == .notice(quiet))
  }

  /// Each output goes quiet on its own; a failure is an error every time.
  @Test func outputsAreQuietOnTheirOwnAndFailuresAreErrors() {
    var log = FrameDumpLog()
    #expect(log.line(for: "a", label: "A", .noNewFrame) != nil)
    #expect(log.line(for: "b", label: "B", .noNewFrame) != nil)
    #expect(log.line(for: "a", label: "A", .failed("disk full")) == .error("A: frame dump: disk full"))
    #expect(log.line(for: "a", label: "A", .failed("disk full")) == .error("A: frame dump: disk full"))
  }
}
