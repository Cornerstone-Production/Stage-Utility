#!/usr/bin/env bash
# Build StageUtilityOutput.app: a release build, wrapped in a bundle, signed ad hoc.
#
#   helper/macos/build-app.sh            -> helper/macos/StageUtilityOutput.app
#   OUT=/some/dir helper/macos/build-app.sh
#
# The version is the repository's package.json version, so the helper and the server
# it ships with carry the same number. CFBundleShortVersionString keeps all of it
# ("1.26.0-beta.5"); CFBundleVersion has to be dotted integers, so it is the part
# before any "-" or "+" ("1.26.0").
#
# The binary is universal (arm64 and x86_64): one build is installed on whichever Mac
# the installer finds. `swift build --arch a --arch b` needs Xcode's xcbuild, which
# the Command Line Tools do not have, so each architecture is built on its own with
# --triple and the two are joined with lipo.
set -euo pipefail
cd "$(dirname "$0")"

OUT="${OUT:-$PWD}"
APP="$OUT/StageUtilityOutput.app"
VERSION="$(node -p "require('../../package.json').version")"
BUNDLE_VERSION="$(printf '%s' "$VERSION" | sed -E 's/^([0-9]+(\.[0-9]+){0,2}).*/\1/')"
if ! printf '%s' "$BUNDLE_VERSION" | grep -Eq '^[0-9]+(\.[0-9]+){0,2}$'; then
  echo "build-app.sh: cannot make dotted integers of the version \"$VERSION\"" >&2
  exit 1
fi

BINS=()
for ARCH in arm64 x86_64; do
  TRIPLE="$ARCH-apple-macosx14.0"
  swift build -c release --triple "$TRIPLE"
  BINS+=("$(swift build -c release --triple "$TRIPLE" --show-bin-path)/StageUtilityOutput")
done

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
lipo -create "${BINS[@]}" -output "$APP/Contents/MacOS/StageUtilityOutput"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.stageutility.output</string>
  <key>CFBundleName</key><string>Stage Utility Output</string>
  <key>CFBundleDisplayName</key><string>Stage Utility Output</string>
  <key>CFBundleExecutable</key><string>StageUtilityOutput</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUNDLE_VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSLocalNetworkUsageDescription</key>
  <string>Stage Utility Output finds the Stage Utility server on your network and loads the screens it shows.</string>
</dict>
</plist>
PLIST

# Ad hoc: no Developer ID. Fine for a copy fetched with curl; see README for what
# it means for the Local Network permission.
codesign --force --sign - "$APP"
codesign --verify --strict "$APP"
echo "built $APP ($VERSION, bundle version $BUNDLE_VERSION, $(lipo -archs "$APP/Contents/MacOS/StageUtilityOutput"))"
