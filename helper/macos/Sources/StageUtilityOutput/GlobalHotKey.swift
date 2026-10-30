import AppKit
import Carbon.HIToolbox
import StageUtilityOutputCore

/// `HelperHotKey`, registered for the whole system. Pressing it calls `action` on
/// the main thread, whichever app is in front and whatever an output has covered.
@MainActor
final class GlobalHotKey {
  private var hotKey: EventHotKeyRef?
  private var handler: EventHandlerRef?
  private let action: () -> Void

  init(action: @escaping () -> Void) { self.action = action }

  /// `noErr` when the key is ours. Another app that already holds the same
  /// combination makes this fail (`eventHotKeyExistsErr`), and then nothing is
  /// registered.
  func register() -> OSStatus {
    guard hotKey == nil else { return noErr }
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let installed = InstallEventHandler(
      GetApplicationEventTarget(),
      { _, _, userData in
        guard let userData else { return OSStatus(eventNotHandledErr) }
        let me = Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue()
        // Carbon delivers on the main thread.
        MainActor.assumeIsolated { me.action() }
        return noErr
      }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &handler)
    guard installed == noErr else { return installed }
    let id = EventHotKeyID(signature: OSType(0x5355_4F48), id: 1)  // 'SUOH'
    let status = RegisterEventHotKey(
      HelperHotKey.keyCode, HelperHotKey.modifiers, id, GetApplicationEventTarget(), 0, &hotKey)
    if status != noErr, let handler {
      RemoveEventHandler(handler)
      self.handler = nil
    }
    return status
  }

  func unregister() {
    if let hotKey { UnregisterEventHotKey(hotKey) }
    if let handler { RemoveEventHandler(handler) }
    hotKey = nil
    handler = nil
  }
}
