import Foundation

/// Turning off a private Objective-C boolean setting by selector name.
///
/// WebKit's keep-painting switches are SPI: methods this helper does not link
/// against and cannot import, only look up by name. They take a `BOOL`, and the one
/// way of calling them from Swift that reads as obvious is wrong.
public enum BoolSwitch {
  /// Set `setter` to false on `object`, then read `getter` back where the object has
  /// one. Nil when it worked; else a description of what did not: the selector's name
  /// when it is missing, or "(did not take)" after it when it exists and the value
  /// is still true. A switch that exists and does nothing is as bad as one that is
  /// missing, and looks like it worked.
  public static func turnOff(_ setter: String, getter: String, on object: NSObject) -> String? {
    let selector = Selector(setter)
    guard object.responds(to: selector), let imp = object.method(for: selector) else { return setter }
    // `object.perform(selector, with: false)` would box the Bool into an NSNumber and
    // pass its POINTER as the BOOL, which reads as true: it turns nothing off, and
    // nothing says so. Call the method with a real ObjCBool.
    typealias SetBool = @convention(c) (AnyObject, Selector, ObjCBool) -> Void
    unsafeBitCast(imp, to: SetBool.self)(object, selector, ObjCBool(false))
    if object.responds(to: Selector(getter)), let v = object.value(forKey: getter) as? Bool, v {
      return "\(setter) (did not take)"
    }
    return nil
  }
}
