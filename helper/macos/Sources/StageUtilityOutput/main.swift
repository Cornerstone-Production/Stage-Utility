import AppKit
import Foundation
import StageUtilityOutputCore

let environment = ProcessInfo.processInfo.environment
let (options, argumentProblems) = Options.parse(CommandLine.arguments, environment: environment)
Log.mirrorToStderr = options.logToStderr
for problem in argumentProblems {
  Log.error(.app, problem)
  FileHandle.standardError.write(Data("StageUtilityOutput: \(problem)\n".utf8))
}
if !argumentProblems.isEmpty { exit(2) }

let paths = HelperPaths.resolve(environment: environment, home: FileManager.default.homeDirectoryForCurrentUser)

if options.listOutputs {
  // Needs the window server for NSScreen, but not a running app.
  _ = NSApplication.shared
  let identity = MacIdentity.load(paths: paths)
  print("mac device id: \(identity.deviceId) (\(identity.source == .installer ? "installer" : "generated"))")
  for d in DisplayEnumerator.current() {
    let on = defaultEnabled(kind: d.descriptor.kind, isMain: d.descriptor.isMain)
    print("\(d.descriptor.key)\t\(DeviceIdentity.deviceId(mac: identity.deviceId, key: d.descriptor.key))\t\(d.descriptor.name)\tdefault \(on ? "on" : "off")")
  }
  exit(0)
}

if SingleInstance.handOverToRunningCopy() {
  FileHandle.standardError.write(Data("StageUtilityOutput: already running; its window was brought forward\n".utf8))
  exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = MainActor.assumeIsolated { AppDelegate(options: options, paths: paths) }
app.delegate = delegate
app.run()
