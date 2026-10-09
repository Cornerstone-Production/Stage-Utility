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
  // Needs the window server for NSScreen, but not a running app. Reads only: a Mac
  // that has no device id yet is told so, not given one.
  _ = NSApplication.shared
  let store = OutputStateStore(directory: paths.userDir)
  let lines = OutputListing.lines(
    identity: MacIdentity.stored(paths: paths),
    displays: DisplayEnumerator.current().map(\.descriptor),
    record: { store.record(for: $0) }, readProblem: store.readProblem)
  for line in lines { print(line) }
  exit(0)
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
