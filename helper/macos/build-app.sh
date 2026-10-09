#!/usr/bin/env bash
# Build StageUtilityOutput.app: a release build, wrapped in a bundle, signed ad hoc.
#
#   helper/macos/build-app.sh            -> helper/macos/StageUtilityOutput.app
#   OUT=/some/dir helper/macos/build-app.sh
#
# The version is the repository's package.json version, so the helper and the server
# it ships with carry the same number.
set -euo pipefail
cd "$(dirname "$0")"

OUT="${OUT:-$PWD}"
APP="$OUT/StageUtilityOutput.app"
VERSION="$(node -p "require('../../package.json').version")"

swift build -c release
BIN="$(swift build -c release --show-bin-path)/StageUtilityOutput"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/StageUtilityOutput"

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
  <key>CFBundleVersion</key><string>$VERSION</string>
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
echo "built $APP ($VERSION)"
