#!/usr/bin/env bash
# Build StageUtilityOutput.app for one architecture: the Swift app, the browser host,
# the Chromium Embedded Framework and CEF's five helper apps, signed ad hoc.
#
#   helper/macos/build-app.sh --arch arm64            -> $OUT/StageUtilityOutput.app
#   helper/macos/build-app.sh --arch x86_64
#   helper/macos/build-app.sh                         -> this Mac's architecture
#
# OUT defaults to helper/macos/dist/<arch>. This is the interface the release
# workflow (added with the installer) calls, once per architecture.
#
# One app per architecture, not a universal one: CEF ships a separate framework for
# each, about 320 MB apiece, and a universal app would carry both to every Mac. The
# installer picks by `sysctl hw.optional.arm64`, arm64 on Apple silicon even under
# Rosetta.
#
# Layout (CEF's, as its cefsimple sample makes it):
#   Contents/MacOS/StageUtilityOutput                       the Swift app
#   Contents/Frameworks/libStageUtilityCEFHost.dylib        the browser host (CEFHost/)
#   Contents/Frameworks/Chromium Embedded Framework.framework
#   Contents/Frameworks/StageUtilityOutput Helper.app       and (Alerts), (GPU),
#                                                           (Plugin), (Renderer)
# Chromium finds the helpers by the main executable's name plus " Helper".
#
# The version is the repository's package.json version, so the helper and the server
# it ships with carry the same number. CFBundleShortVersionString keeps all of it
# ("1.26.0-beta.5"); CFBundleVersion has to be dotted integers, so it is the part
# before any "-" or "+" ("1.26.0").
set -euo pipefail
cd "$(dirname "$0")"

ARCH="$(uname -m)"
while [ $# -gt 0 ]; do
  case "$1" in
    --arch)
      [ $# -ge 2 ] || { echo "build-app.sh: --arch needs arm64 or x86_64" >&2; exit 2; }
      ARCH="$2"
      shift 2
      ;;
    *) echo "build-app.sh: unknown argument $1 (use --arch arm64|x86_64)" >&2; exit 2 ;;
  esac
done
case "$ARCH" in arm64|x86_64) ;; *) echo "build-app.sh: unknown architecture $ARCH" >&2; exit 2 ;; esac
OUT="${OUT:-$PWD/dist/$ARCH}"
EXE=StageUtilityOutput
BUNDLE_ID=com.stageutility.output
VERSION="$(node -p "require('../../package.json').version")"
BUNDLE_VERSION="$(printf '%s' "$VERSION" | sed -E 's/^([0-9]+(\.[0-9]+){0,2}).*/\1/')"
if ! printf '%s' "$BUNDLE_VERSION" | grep -Eq '^[0-9]+(\.[0-9]+){0,2}$'; then
  echo "build-app.sh: cannot make dotted integers of the version \"$VERSION\"" >&2
  exit 1
fi

helper_plist() { # <executable name> <bundle id suffix>
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID.helper$2</string>
  <key>CFBundleName</key><string>$1</string>
  <key>CFBundleDisplayName</key><string>$1</string>
  <key>CFBundleExecutable</key><string>$1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUNDLE_VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>LSFileQuarantineEnabled</key><true/>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
PLIST
}

{
  HOST="$(./build-cef-host.sh "$ARCH" | tail -n 1)"
  CEF="$(./fetch-cef.sh "$ARCH" | tail -n 1)"

  TRIPLE="$ARCH-apple-macosx14.0"
  swift build -c release --triple "$TRIPLE"
  BIN="$(swift build -c release --triple "$TRIPLE" --show-bin-path)/$EXE"

  APP="$OUT/$EXE.app"
  FW="$APP/Contents/Frameworks"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$FW"
  cp "$BIN" "$APP/Contents/MacOS/$EXE"
  cp "$HOST/libStageUtilityCEFHost.dylib" "$FW/"

  # The framework in its versioned layout, as CEF's COPY_MAC_FRAMEWORK makes it.
  CEF_FW="$FW/Chromium Embedded Framework.framework"
  mkdir -p "$CEF_FW/Versions"
  ditto "$CEF/Release/Chromium Embedded Framework.framework" "$CEF_FW/Versions/A"
  ln -s A "$CEF_FW/Versions/Current"
  for item in "Chromium Embedded Framework" Libraries Resources; do ln -s "Versions/A/$item" "$CEF_FW/$item"; done

  # The helper apps, one executable under five names.
  for suffix in "::" " (Alerts)::.alerts" " (GPU)::.gpu" " (Plugin)::.plugin" " (Renderer)::.renderer"; do
    name="$EXE Helper${suffix%%::*}"
    idsuffix="${suffix##*::}"
    mkdir -p "$FW/$name.app/Contents/MacOS"
    cp "$HOST/stage_cef_helper" "$FW/$name.app/Contents/MacOS/$name"
    helper_plist "$name" "$idsuffix" > "$FW/$name.app/Contents/Info.plist"
  done

  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>Stage Utility Output</string>
  <key>CFBundleDisplayName</key><string>Stage Utility Output</string>
  <key>CFBundleExecutable</key><string>$EXE</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUNDLE_VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
  <key>NSAppSleepDisabled</key><true/>
  <key>NSPrincipalClass</key><string>StageUtilityCEFApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSLocalNetworkUsageDescription</key>
  <string>Stage Utility Output finds the Stage Utility server on your network and loads the screens it shows.</string>
</dict>
</plist>
PLIST

  # Ad hoc, inside out: the framework's libraries, the framework, the host, each
  # helper, then the app. No Developer ID; see README for what that means for the
  # Local Network permission.
  for lib in "$CEF_FW/Versions/A/Libraries/"*.dylib; do codesign --force --sign - "$lib"; done
  codesign --force --sign - "$CEF_FW"
  codesign --force --sign - "$FW/libStageUtilityCEFHost.dylib"
  for helper in "$FW/$EXE Helper"*.app; do codesign --force --sign - "$helper"; done
  codesign --force --sign - "$APP"
  # Not --deep: it reports the versioned framework as missing although the plain
  # strict check below validates every nested item, the framework included.
  codesign --verify --strict "$APP"
  echo "built $APP ($VERSION, bundle version $BUNDLE_VERSION, $ARCH, $(du -sh "$APP" | cut -f1))"
}
