import AppKit
import DeckLinkKit
import StageUtilityOutputCore

/// A display the Mac has right now, with the screen to put a window on.
struct ConnectedDisplay {
  var descriptor: OutputDescriptor
  var screen: NSScreen
}

/// An output the helper can drive now: a display, with the screen its window goes
/// on, or a card port, which has none.
struct PresentOutput {
  var descriptor: OutputDescriptor
  /// A display output's screen.
  var screen: NSScreen?
  /// A card output's port: a DeckLink port, or `.virtual`.
  var card: DeckLinkOutputPort.Hardware?

  init(descriptor: OutputDescriptor, screen: NSScreen? = nil, card: DeckLinkOutputPort.Hardware? = nil) {
    self.descriptor = descriptor
    self.screen = screen
    self.card = card
  }

  init(display: ConnectedDisplay) { self.init(descriptor: display.descriptor, screen: display.screen) }
}

enum DisplayEnumerator {
  /// Every screen macOS lists, as outputs of kind "display".
  static func current() -> [ConnectedDisplay] {
    let screens = NSScreen.screens
    // screens[0] is the screen with the menu bar.
    return screens.enumerated().compactMap { index, screen in
      guard let uuid = displayUUID(of: screen) else {
        Log.error(.output, "a screen has no display UUID and is skipped: \(screen.localizedName)")
        return nil
      }
      let key = DeviceIdentity.outputKey(displayUUID: uuid)
      let names = OutputNaming.display(connector: connector(of: screen), index: index + 1, localizedName: screen.localizedName)
      return ConnectedDisplay(
        descriptor: OutputDescriptor(kind: .display, key: key, name: names.name, port: names.port, isMain: index == 0),
        screen: screen)
    }
  }

  /// `CGDisplayCreateUUIDFromDisplayID`, which survives reboots and re-plugging.
  static func displayUUID(of screen: NSScreen) -> String? {
    guard let displayID = displayID(of: screen), let unmanaged = CGDisplayCreateUUIDFromDisplayID(displayID) else { return nil }
    return CFUUIDCreateString(nil, unmanaged.takeRetainedValue()) as String?
  }

  /// The connector, where macOS says. It names the built-in panel and nothing else
  /// without reaching into IOKit paths that change between Macs; every other
  /// display is "Display N".
  static func connector(of screen: NSScreen) -> String? {
    guard let displayID = displayID(of: screen) else { return nil }
    return CGDisplayIsBuiltin(displayID) != 0 ? "Built-in" : nil
  }

  private static func displayID(of screen: NSScreen) -> CGDirectDisplayID? {
    guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
    return CGDirectDisplayID(number.uint32Value)
  }
}
