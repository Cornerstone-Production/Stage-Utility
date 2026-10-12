#!/usr/bin/env bash
# Run the core tests with swift-testing.
#
# With full Xcode, `swift test` just works. With only the Command Line Tools the
# Testing framework is on disk but not on the default search paths, so it is named
# here: -F for the compiler and linker, and an rpath for the framework and for
# lib_TestingInterop.dylib, which lives in a different directory again.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(xcode-select -p)" = "/Library/Developer/CommandLineTools" ]; then
  FW=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
  LIB=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
  exec swift test "$@" \
    -Xswiftc -F -Xswiftc "$FW" \
    -Xlinker -F -Xlinker "$FW" \
    -Xlinker -rpath -Xlinker "$FW" \
    -Xlinker -rpath -Xlinker "$LIB"
fi
exec swift test "$@"
