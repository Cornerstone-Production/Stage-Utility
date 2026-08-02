#!/usr/bin/env bash
#
# run-macos.sh — does a detached child survive `launchctl bootout`?
#
# This is the teardown `brew services stop` performs, and a Homebrew track
# switch depends on surviving it: uninstall stops the agent, and the work
# (install, then services start) continues afterwards.
#
# launchd kills by JOB, and spawning with detached:true calls setsid(), which
# escapes it. Verified by hand on 2026-08-02; this makes it repeatable.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
LABEL="com.cornerstone.stage-survival-test"
PLIST="$(mktemp -t survival).plist"
LOG="$(mktemp)"

cleanup() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST"
}
trap cleanup EXIT

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$HERE/parent.mjs</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>SURVIVAL_LOG</key><string>$LOG</string>
  </dict>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLISTEOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
# bootstrap does not reliably honour RunAtLoad, so start it explicitly.
launchctl kickstart "gui/$(id -u)/$LABEL"

sleep 4
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
sleep 14

if grep -q FINISHED "$LOG" 2>/dev/null; then
  echo "  macos survival: detached child outlived launchctl bootout and finished"
else
  echo "  macos survival: FAILED - the child did not finish after bootout"
  echo "  --- log ---"; sed 's/^/    /' "$LOG"
  echo "  A Homebrew track switch cannot be trusted while this fails: the"
  echo "  install step runs after the agent has been stopped."
  exit 1
fi
