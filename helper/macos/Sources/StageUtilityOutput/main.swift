import AppKit
import DeckLinkKit
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
  // Needs the window server for NSScreen, but not a running app. Reads only: a Mac
  // that has no device id yet is told so, not given one.
  _ = NSApplication.shared
  let store = OutputStateStore(directory: paths.userDir)
  let lines = OutputListing.lines(
    identity: MacIdentity.stored(paths: paths),
    displays: DisplayEnumerator.current().map(\.descriptor)
      + DeckLinkDriver.ports().filter(\.canPlay).map(\.descriptor)
      + VirtualCards.outputs(count: options.virtualSDI),
    record: { store.record(for: $0) }, readProblem: store.readProblem)
  for line in lines { print(line) }
  exit(0)
}

if let key = options.newTokenFor {
  _ = NSApplication.shared
  // The running copy holds outputs.json in memory and would write the old token back.
  if SingleInstance.otherCopy() != nil {
    FileHandle.standardError.write(
      Data("StageUtilityOutput: quit Stage Utility Output first (Quit in its window), then run this again\n".utf8))
    exit(1)
  }
  let result = TokenRotation.run(
    store: OutputStateStore(directory: paths.userDir), key: key, macDeviceId: MacIdentity.stored(paths: paths)?.deviceId)
  for line in result.lines { print(line) }
  if result.succeeded {
    Log.notice(.state, "\(key): given a new token from the command line; it is set up again on the server by releasing it and setting it up")
  } else {
    Log.error(.state, "--new-token \(key): \(result.lines.first ?? "failed")")
  }
  exit(result.succeeded ? 0 : 1)
}

if SingleInstance.handOverToRunningCopy() {
  FileHandle.standardError.write(Data("StageUtilityOutput: already running; its window was brought forward\n".utf8))
  exit(0)
}

// Chromium first: it needs the app object made from its own NSApplication subclass.
let app = MainActor.assumeIsolated { CEFEngine.start(paths: paths) }
app.setActivationPolicy(.accessory)
let delegate = MainActor.assumeIsolated { AppDelegate(options: options, paths: paths) }
app.delegate = delegate
MainActor.assumeIsolated { CEFEngine.run(app) }
exit(0)
