import Foundation

/// One screen as `GET /api/outputs` lists it, as far as the helper reads it.
public struct ScreenRecord: Equatable {
  public var id: String
  public var slug: String?
  public var name: String
  public var rotation: Rotation

  public init(id: String, slug: String? = nil, name: String, rotation: Rotation = .none) {
    self.id = id
    self.slug = slug
    self.name = name
    self.rotation = rotation
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
  ///
  /// `videoMode` is read by nobody here: it is a DeckLink port's setting, and
  /// display outputs, the only kind this helper drives so far, have none.
  public static func parse(status: Int, body: Data) -> Result<[ScreenRecord], ReadError> {
    guard status == 200 else { return .failure(.status(status)) }
    guard let list = (try? JSONSerialization.jsonObject(with: body)) as? [[String: Any]] else { return .failure(.notAList) }
    return .success(
      list.compactMap { o in
        guard let id = o["id"] as? String, let name = o["name"] as? String else { return nil }
        return ScreenRecord(id: id, slug: o["slug"] as? String, name: name, rotation: Rotation(serverValue: o["rotation"]))
      })
  }

  /// The screen a path segment names: `/enroll` redirects to the id, and the
  /// friendly link is the slug.
  public static func find(_ ref: String, in screens: [ScreenRecord]) -> ScreenRecord? {
    screens.first { $0.id == ref || $0.slug == ref }
  }
}
