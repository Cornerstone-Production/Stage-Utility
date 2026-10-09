import CoreGraphics
import Foundation
import Testing
@testable import StageUtilityOutputCore

@Suite struct RotationTests {
  let window = CGSize(width: 1920, height: 1080)

  /// The page must lay out at the turned size: a screen on its side is a portrait
  /// page. Without the swap the picture is only a 1920 x 1080 page rotated about
  /// its centre, spilling off the top and bottom of the window.
  @Test func aQuarterTurnLaysTheSurfaceOutAtTheSwappedSize() {
    for r in [Rotation.clockwise90, .clockwise270] {
      let l = r.layout(inWindow: window)
      #expect(l.frame.size == CGSize(width: 1080, height: 1920), "\(r)")
    }
  }

  @Test func noTurnAndAHalfTurnKeepTheWindowsSize() {
    for r in [Rotation.none, .clockwise180] {
      #expect(r.layout(inWindow: window).frame == CGRect(x: 0, y: 0, width: 1920, height: 1080), "\(r)")
    }
  }

  /// A rotation about the frame's centre has to be about the window's centre.
  @Test func theSurfaceIsCentredOnTheWindow() {
    for r in [Rotation.none, .clockwise90, .clockwise180, .clockwise270] {
      let f = r.layout(inWindow: window).frame
      #expect(f.midX == 960 && f.midY == 540, "\(r)")
    }
    #expect(Rotation.clockwise90.layout(inWindow: window).frame.origin == CGPoint(x: 420, y: -420))
  }

  @Test func theTurnIsClockwiseDegrees() {
    #expect([Rotation.none, .clockwise90, .clockwise180, .clockwise270].map { $0.layout(inWindow: window).clockwiseDegrees }
      == [0, 90, 180, 270])
  }

  @Test func readsTheServersValueAndTreatsAnythingElseAsUpright() {
    #expect(Rotation(serverValue: 90 as NSNumber) == .clockwise90)
    #expect(Rotation(serverValue: 270 as NSNumber) == .clockwise270)
    #expect(Rotation(serverValue: nil) == .none)
    #expect(Rotation(serverValue: NSNull()) == .none)
    #expect(Rotation(serverValue: 45 as NSNumber) == .none)
    #expect(Rotation(serverValue: 90.5 as NSNumber) == .none)
    #expect(Rotation(serverValue: "90") == .none)
  }
}

@Suite struct ScreenListTests {
  func body(_ json: String) -> Data { Data(json.utf8) }

  @Test func readsNameSlugAndRotation() throws {
    let r = ScreenList.parse(
      status: 200,
      body: body(#"[{"id":"o1","slug":"wing","name":"Wing","rotation":90,"viewId":"v"},{"id":"o2","name":"Lobby"}]"#))
    let list = try r.get()
    #expect(list == [
      ScreenRecord(id: "o1", slug: "wing", name: "Wing", rotation: .clockwise90),
      ScreenRecord(id: "o2", slug: nil, name: "Lobby", rotation: .none),
    ])
  }

  /// A card output reopens its port in the screen's format; one with none, or one
  /// that is not a string, gets the default.
  @Test func readsTheVideoMode() throws {
    let list = try ScreenList.parse(
      status: 200, body: body(#"[{"id":"o1","name":"A","videoMode":"720p59.94"},{"id":"o2","name":"B"},{"id":"o3","name":"C","videoMode":50}]"#)
    ).get()
    #expect(list.map(\.videoMode) == ["720p59.94", nil, nil])
  }

  @Test func saysWhyItIsNotAListing() {
    #expect(ScreenList.parse(status: 503, body: body("[]")) == .failure(.status(503)))
    #expect(ScreenList.parse(status: 200, body: body("{}")) == .failure(.notAList))
    #expect(ScreenList.parse(status: 200, body: body("nope")) == .failure(.notAList))
  }

  @Test func skipsAScreenWithoutAnIdOrName() throws {
    let list = try ScreenList.parse(status: 200, body: body(#"[{"name":"x"},{"id":"o1"},{"id":"o2","name":"ok"}]"#)).get()
    #expect(list.map(\.id) == ["o2"])
  }

  @Test func findsByIdOrSlug() {
    let list = [ScreenRecord(id: "o1", slug: "wing", name: "Wing"), ScreenRecord(id: "o2", name: "Lobby")]
    #expect(ScreenList.find("o2", in: list)?.name == "Lobby")
    #expect(ScreenList.find("wing", in: list)?.name == "Wing")
    #expect(ScreenList.find("nope", in: list) == nil)
  }
}
