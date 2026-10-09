#!/usr/bin/env bash
# Build the browser host (CEFHost/) for one architecture:
# libStageUtilityCEFHost.dylib and the helper executable, into .cef-build/<arch>/.
#
#   helper/macos/build-cef-host.sh arm64
#
# Fetches and checks the pinned CEF first (fetch-cef.sh). CMake and Ninja come from
# a Python venv in .tools/ (gitignored), made on first use and again whenever
# build-tools.txt changes, so nothing is installed system-wide and the Command Line
# Tools are enough. Their versions and wheel hashes are pinned in build-tools.txt.
set -euo pipefail
cd "$(dirname "$0")"

ARCH="${1:-$(uname -m)}"
CEF_ROOT="$(./fetch-cef.sh "$ARCH" | tail -n 1)"

TOOLS="$PWD/.tools/venv"
if ! cmp -s build-tools.txt "$TOOLS/build-tools.txt"; then
  echo "making $TOOLS with the cmake and ninja build-tools.txt pins" >&2
  rm -rf "$TOOLS"
  python3 -m venv "$TOOLS"
  "$TOOLS/bin/pip" install --quiet --disable-pip-version-check --require-hashes --only-binary :all: \
    -r build-tools.txt
  cp build-tools.txt "$TOOLS/build-tools.txt"
fi
export PATH="$TOOLS/bin:$PATH"

BUILD="$PWD/.cef-build/$ARCH"
cmake -S CEFHost -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCEF_ROOT="$CEF_ROOT" -DPROJECT_ARCH="$ARCH" -DUSE_SANDBOX=ON >&2
cmake --build "$BUILD" >&2
echo "$BUILD/Release"
