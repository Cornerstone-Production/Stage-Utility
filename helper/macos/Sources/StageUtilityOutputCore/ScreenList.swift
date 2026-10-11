import Foundation

/// One screen as `GET /api/outputs` lists it, as far as the helper reads it.
public struct ScreenRecord: Equatable {
  public var id: String
  public var slug: String?
  public var name: String
  public var rotation: Rotation
  /// A card output's format ("1080p59.94"); nil when the screen has none, which is
  /// the default. Meaningless for a display.
  public var videoMode: String?

  public init(id: String, slug: String? = nil, name: String, rotation: Rotation = .none, videoMode: String? = nil) {
    self.id = id
    self.slug = slug
    self.name = name
    self.rotation = rotation
    self.videoMode = videoMode
  }
}

public enum ScreenList {
  public enum ReadError: Error, Equatable, CustomStringConvertible {
    case status(Int)
    case notAList

    public var description: String {
      switch self {
      case .status(let n): return "the server answered HTTP \(n)"
      case .notAList: return "the server's answer was not a list of screens"
      }
    }
  }

  /// The listing, or why it is not one. A screen with no id or no name is skipped.
  /// A `videoMode` that is not a string is read as none: the port's default.
  public static func parse(status: Int, body: Data) -> Result<[ScreenRecord], ReadError> {
    guard status == 200 else { return .failure(.status(status)) }
    guard let list = (try? JSONSerialization.jsonObject(with: body)) as? [[String: Any]] else { return .failure(.notAList) }
    return .success(
      list.compactMap { o in
        guard let id = o["id"] as? String, let name = o["name"] as? String else { return nil }
        return ScreenRecord(
          id: id, slug: o["slug"] as? String, name: name, rotation: Rotation(serverValue: o["rotation"]),
          videoMode: o["videoMode"] as? String)
      })
  }

  /// The screen a path segment names: `/enroll` redirects to the id, and the
  /// friendly link is the slug.
  public static func find(_ ref: String, in screens: [ScreenRecord]) -> ScreenRecord? {
    screens.first { $0.id == ref || $0.slug == ref }
  }
}
