#!/bin/sh
# Turn this Mac into Stage Utility screens.
#
#   curl -fsSL http://<server>/kiosk/install-macos.sh | sudo sh
#
# By default this installs the Stage Utility Output helper (macOS 14 or later): a
# menu bar app that makes each of the Mac's displays, and each DeckLink port, a
# screen device of its own. It downloads the app from this server, falls back to
# the GitHub release for the server's version, checks a published SHA-256, puts it
# in /Applications and starts it at login, for whichever account logs in.
#
#   --browser    the earlier Chrome kiosk instead: one full-screen browser. For a
#                Mac the helper cannot run on.
#                curl -fsSL http://<server>/kiosk/install-macos.sh | sudo sh -s -- --browser
#   --dry-run    print every step and change nothing. Needs no sudo.
#   --help       this text
#
#   STAGE_SERVER=http://<server>   where to download from and, for the Chrome
#                                  kiosk, a server to use instead of discovery.
#                                  Written to the `server` file, which skips
#                                  discovery: set it only where broadcast does not
#                                  cross.
#   STAGE_KIOSK_PORT=8789          the discovery port of the Chrome kiosk
#
# Running it again upgrades in place. It never mints a second device id.
#
# Best-effort, and honestly so: a Mac is a general-purpose machine that sleeps,
# locks and reboots for updates on its own schedule. For a permanent wall screen
# a purpose-built Pi is the right tool. This is for a Mac mini in the booth, a
# laptop on a cart, or a Mac already sitting at FOH.
#
# What it cannot do for you, once, at the Mac: see the notes it prints at the end.
#
# POSIX sh on purpose: it is piped to `sh`, which on macOS is bash in POSIX mode.
# The STAGE_INSTALL_* variables below exist for the tests and nothing else.

set -eu

# Stamped by the server that serves this file with the address it was fetched
# from, so the app can be downloaded from the same place. Empty when the file was
# saved and run by hand.
FETCHED_FROM=""

# Prefix for every path below. Empty on a real install; a test points it at a
# scratch directory so the real functions run without touching the Mac.
ROOT="${STAGE_INSTALL_TEST_ROOT:-}"

STATE_DIR="$ROOT/Library/Application Support/StageUtility"
APPS_DIR="$ROOT/Applications"
BIN="$ROOT/usr/local/bin/stage-utility-kiosk"
AGENT_DIR="$ROOT/Library/LaunchAgents"
KIOSK_LABEL=com.stageutility.kiosk
AGENT="$AGENT_DIR/$KIOSK_LABEL.plist"
PORT="${STAGE_KIOSK_PORT:-8789}"
SERVER="${STAGE_SERVER:-}"

APP_NAME=StageUtilityOutput.app
APP_EXEC=StageUtilityOutput
HELPER_LABEL=com.stageutility.output
# System-wide, like the Chrome kiosk's agent: root-owned, loaded at any GUI login,
# so it needs no account to exist when this runs.
HELPER_PLIST="$AGENT_DIR/$HELPER_LABEL.plist"
GITHUB_BASE="${STAGE_INSTALL_GITHUB_BASE:-https://github.com/Cornerstone-Production/Stage-Utility/releases/download}"

MODE=helper
DRY=0
ARCH=""
ZIP_NAME=""
WHY=""
HTTP_CODE=""
CONSOLE_USER=""
CONSOLE_UID=""
WORK=""
STAGING=""
OLD_APP=""
# What this run has changed, so a failure can put each thing back. Nothing is
# "done" until FINISHED=1, which is set only once the whole install worked.
APP_SWAPPED=0
AGENT_STOPPED=0
AGENT_STARTED=0
PLIST_WRITTEN=0
PLIST_BACKUP=""
MARKER_CREATED=0
KIOSK_BACKED_UP=0
KIOSK_STOPPED=0
FINISHED=0
MIGRATED=0
# Tells the helper this Mac was a Chrome kiosk, so its main display takes over the
# kiosk's binding (the bare device id and the installer's token) and starts on.
MARKER="$STATE_DIR/migrated-from-kiosk"

say() { printf '%s\n' "$*"; }
warn() { printf 'install-macos.sh: %s\n' "$*" >&2; }
die() {
  warn "$*"
  exit 1
}
# What a dry run would have done.
would() { printf '    [dry-run] %s\n' "$*"; }

usage() {
  cat <<'USAGE'
Usage: install-macos.sh [--browser] [--dry-run]

  (default)   install the Stage Utility Output helper (macOS 14 or later)
  --browser   install the Chrome kiosk instead
  --dry-run   print every step and change nothing; needs no sudo
  --help      this text

Run as root: curl -fsSL http://<server>/kiosk/install-macos.sh | sudo sh
Options go after -s --:  ... | sudo sh -s -- --dry-run
STAGE_SERVER=http://<server> names the server to download from.
USAGE
}

# ── Cleanup, and never a half-installed app ────────────────────────────────
# Runs on every exit, including a `set -e` exit from a command nobody wrapped, so
# any failure after the first change leaves the Mac as it was: the new app gone and
# the old one back, the helper's agent file as it was, and the helper running again
# if it was running. On success the old copy is deleted.
roll_back() {
  if [ "$AGENT_STARTED" -eq 1 ] && [ -n "$CONSOLE_UID" ]; then
    launchctl bootout "gui/$CONSOLE_UID/$HELPER_LABEL" || warn "could not stop the new helper again"
  fi
  if [ -n "$OLD_APP" ] && [ -d "$OLD_APP" ]; then
    rm -rf "${APPS_DIR:?}/$APP_NAME"
    if mv "$OLD_APP" "$APPS_DIR/$APP_NAME"; then
      say "    restored the previous $APP_NAME"
    else
      warn "could not put the previous $APP_NAME back; it is at $OLD_APP"
    fi
  elif [ "$APP_SWAPPED" -eq 1 ]; then
    rm -rf "${APPS_DIR:?}/$APP_NAME"
    say "    removed the $APP_NAME that was just installed"
  fi
  if [ "$PLIST_WRITTEN" -eq 1 ]; then
    if [ -n "$PLIST_BACKUP" ] && [ -f "$PLIST_BACKUP" ]; then
      if cp -p "$PLIST_BACKUP" "$HELPER_PLIST"; then
        say "    restored the previous $HELPER_PLIST"
      else
        warn "could not restore $HELPER_PLIST"
      fi
    else
      rm -f "$HELPER_PLIST"
      say "    removed $HELPER_PLIST"
    fi
  fi
  if [ "$MARKER_CREATED" -eq 1 ]; then
    rm -f "$MARKER"
    say "    removed $MARKER"
  fi
  if [ "$AGENT_STOPPED" -eq 1 ]; then
    start_helper_agent || warn "could not restart the helper after a failed install; it starts at the next login"
  fi
  if [ "$KIOSK_BACKED_UP" -eq 1 ]; then
    if [ -f "$WORK/kiosk/launcher" ] && [ ! -e "$BIN" ]; then cp -p "$WORK/kiosk/launcher" "$BIN"; fi
    if [ -f "$WORK/kiosk/agent.plist" ] && [ ! -e "$AGENT" ]; then cp -p "$WORK/kiosk/agent.plist" "$AGENT"; fi
  fi
  if [ "$KIOSK_STOPPED" -eq 1 ] && [ -f "$AGENT" ] && [ -n "$CONSOLE_UID" ]; then
    launchctl bootstrap "gui/$CONSOLE_UID" "$AGENT" || warn "could not restart the Chrome kiosk; it starts at the next login"
  fi
}

on_exit() {
  status=$?
  # A failing command in a cleanup must not end the cleanup.
  set +e
  if [ "$FINISHED" -ne 1 ]; then
    roll_back
  elif [ -n "$OLD_APP" ]; then
    rm -rf "$OLD_APP"
  fi
  if [ -n "$STAGING" ]; then rm -rf "$STAGING"; fi
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  exit "$status"
}

# ── What this Mac is ───────────────────────────────────────────────────────
detect_arch() {
  machine="${STAGE_INSTALL_TEST_UNAME_M:-$(uname -m)}"
  # `uname -m` says x86_64 to a shell running under Rosetta 2 (an Intel Terminal on
  # Apple silicon), which would install the Intel app on a Mac that can run the
  # native one. hw.optional.arm64 is 1 on Apple silicon whatever the process is
  # translated as, and does not exist on an Intel Mac, so it decides first and
  # uname is the fallback. The variable is empty-but-set to mean "no such key".
  hw_arm64="${STAGE_INSTALL_TEST_HW_ARM64-$(sysctl -n hw.optional.arm64 2>/dev/null || true)}"
  if [ "$hw_arm64" = 1 ]; then
    ARCH=arm64
    return 0
  fi
  case "$machine" in
    arm64) ARCH=arm64 ;;
    x86_64) ARCH=x86_64 ;;
    *) die "this Mac reports the architecture \"$machine\"; the output helper is built for arm64 and x86_64. Use --browser for the Chrome kiosk." ;;
  esac
}

check_macos() {
  system="${STAGE_INSTALL_TEST_UNAME_S:-$(uname -s)}"
  [ "$system" = Darwin ] || die "this installer is for macOS; this is $system."
  version="${STAGE_INSTALL_TEST_OS_VERSION:-$(sw_vers -productVersion)}"
  major="${version%%.*}"
  case "$major" in
    '' | *[!0-9]*) die "could not read the macOS version (\"$version\")." ;;
  esac
  if [ "$MODE" = helper ] && [ "$major" -lt 14 ]; then
    die "the output helper needs macOS 14 or later; this is macOS $version. Use --browser for the Chrome kiosk."
  fi
}

# The account at the keyboard, if any. The installer runs as root and the helper
# is a per-user app, so this decides what can be done NOW: starting the helper in
# that account's session, and handing it the token. With nobody logged in the
# install still completes, and the helper starts at the next login.
find_console_user() {
  if [ -n "${STAGE_INSTALL_TEST_CONSOLE_USER:-}" ]; then
    CONSOLE_USER="$STAGE_INSTALL_TEST_CONSOLE_USER"
    if [ "$CONSOLE_USER" = none ]; then CONSOLE_USER=""; fi
  else
    CONSOLE_USER="$(stat -f %Su /dev/console 2>/dev/null || true)"
  fi
  CONSOLE_UID=""
  if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != root ]; then
    CONSOLE_UID="$(id -u "$CONSOLE_USER" 2>/dev/null)" || CONSOLE_UID=""
  fi
  if [ -z "$CONSOLE_UID" ]; then CONSOLE_USER=""; fi
}

# ── The device's identity, kept across installs ────────────────────────────
# Shared by both modes. The id is generated ONCE: re-running must never mint a
# new one, or this Mac's bindings are orphaned and need claiming again.
write_state() {
  if [ "$DRY" -eq 1 ]; then
    if [ -f "$STATE_DIR/device-id" ]; then
      would "keep the device id $(cat "$STATE_DIR/device-id") and the token in $STATE_DIR"
    else
      would "create a device id and a token in $STATE_DIR"
    fi
    if [ -n "$SERVER" ]; then would "write $SERVER to $STATE_DIR/server"; fi
    if [ -n "$CONSOLE_USER" ]; then
      would "give the token to $CONSOLE_USER, mode 600"
    else
      would "leave the token readable by administrators: nobody is logged in"
    fi
    return 0
  fi
  mkdir -p "$STATE_DIR"
  [ -f "$STATE_DIR/device-id" ] || uuidgen | tr '[:upper:]' '[:lower:]' >"$STATE_DIR/device-id"
  # The device's own secret: pinned by the server the first time it is claimed.
  [ -f "$STATE_DIR/token" ] || head -c 24 /dev/urandom | xxd -p | tr -d '\n' >"$STATE_DIR/token"
  [ -n "$SERVER" ] && printf '%s' "$SERVER" >"$STATE_DIR/server" || true
  chmod 644 "$STATE_DIR/device-id"
  # The token is readable ONLY by the account that runs the app.
  #
  # Owned by that account, not by root. The installer runs under sudo but the
  # LaunchAgent runs as the LOGGED-IN GUI user, so a 0600 root-owned token read
  # as empty, the device enrolled with no token, and the server's authorise() is
  # `if (!device || !secret) return null` -- unconditionally null, including
  # after the operator claims the screen.
  #
  # The whole directory, because the Chrome kiosk also records the server binding
  # here.
  if [ -n "$CONSOLE_USER" ]; then
    chown -R "$CONSOLE_USER" "$STATE_DIR"
    chmod 600 "$STATE_DIR/token"
    say "    kiosk user: $CONSOLE_USER"
  else
    # No GUI session yet -- an install over SSH, or at the login window. The helper
    # starts at the next login as whichever account that is, and it must be able to
    # read the token then. Readable by the administrators group, not unreadable and
    # not by everyone: a silent 0600 here is exactly the failure this block exists
    # to prevent, and it presents as a screen that enrols for ever.
    chgrp admin "$STATE_DIR/token" || warn "could not give the administrators group the token"
    chmod 640 "$STATE_DIR/token"
    say "    no console user yet: the token is readable by administrators. If the account"
    say "    that logs in first is not one, re-run this installer after it has."
  fi
  say "    device id: $(cat "$STATE_DIR/device-id")"
}

# ── Getting the app ────────────────────────────────────────────────────────
# Where the server is, for the download: the operator's STAGE_SERVER, else the
# address this script was served from, else the server file of an earlier
# install. Empty when none of them is known.
server_origin() {
  if [ -n "$SERVER" ]; then
    printf '%s' "$SERVER"
  elif [ -n "$FETCHED_FROM" ]; then
    printf '%s' "$FETCHED_FROM"
  elif [ -r "$STATE_DIR/server" ]; then
    tr -d '\r\n' <"$STATE_DIR/server"
  fi
}

no_server_address() {
  die "no server address to download from. Run the command from the server's Settings page, or: sudo STAGE_SERVER=http://<server> sh install-macos.sh"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# GET one URL into a file. Sets HTTP_CODE, and WHY when it was not a 200. The
# server explains its refusals in a JSON body ("not in the cache and could not be
# fetched: ..."), and `curl -f` would throw that away, so the body is read.
fetch_to() {
  url="$1"
  dest="$2"
  max="$3"
  progress="$4"
  HTTP_CODE=""
  rc=0
  if [ "$progress" -eq 1 ]; then
    HTTP_CODE="$(curl -# -L --connect-timeout 10 --max-time "$max" -o "$dest" -w '%{http_code}' "$url")" || rc=$?
  else
    HTTP_CODE="$(curl -sS -L --connect-timeout 10 --max-time "$max" -o "$dest" -w '%{http_code}' "$url")" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    WHY="could not reach it (curl exit $rc)"
    return 1
  fi
  if [ "$HTTP_CODE" != 200 ]; then
    reason="$(head -c 400 "$dest" 2>/dev/null | tr '\r\n' '  ' | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')"
    WHY="answered $HTTP_CODE${reason:+: $reason}"
    rm -f "$dest"
    return 1
  fi
}

# One download source: the checksum, then the zip, then the comparison. Returns
# non-zero with the reason in WHY, and leaves no zip it would trust behind.
try_source() {
  label="$1"
  zip_url="$2"
  sum_url="$3"
  WHY=""
  rm -f "$WORK/$ZIP_NAME" "$WORK/$ZIP_NAME.sha256"
  if ! fetch_to "$sum_url" "$WORK/$ZIP_NAME.sha256" 60 0; then
    WHY="$label: the checksum $WHY"
    return 1
  fi
  expected="$(awk 'NR == 1 { print tolower($1) }' "$WORK/$ZIP_NAME.sha256")"
  case "$expected" in
    *[!0-9a-f]* | '')
      WHY="$label: the checksum is not a SHA-256 digest"
      return 1
      ;;
  esac
  if [ "${#expected}" -ne 64 ]; then
    WHY="$label: the checksum is not a SHA-256 digest"
    return 1
  fi
  say "    downloading $ZIP_NAME from $label"
  say "    (a server that has not fetched it yet downloads it from GitHub first; that can take a few minutes)"
  if ! fetch_to "$zip_url" "$WORK/$ZIP_NAME" 1800 1; then
    WHY="$label: the download $WHY"
    return 1
  fi
  actual="$(sha256_of "$WORK/$ZIP_NAME")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$WORK/$ZIP_NAME"
    WHY="$label: the download did not match its published SHA-256 (expected $expected, got $actual)"
    return 1
  fi
  say "    verified SHA-256 $expected"
}

# The server's own release version, for the GitHub fallback. /api/update/status
# carries it ("1.26.0"); /api/version is a build id, not a release.
release_version() {
  curl -fsS --connect-timeout 10 --max-time 15 "$1/api/update/status" 2>/dev/null |
    grep -o '"version":"[^"]*"' | head -n 1 | cut -d'"' -f4
}

# A verified zip at $WORK/$ZIP_NAME, from the server or else the release.
fetch_helper() {
  origin="$(server_origin)"
  [ -n "$origin" ] || no_server_address
  origin="${origin%/}"
  ZIP_NAME="StageUtilityOutput-$ARCH.zip"
  if try_source "this server ($origin)" "$origin/kiosk/$ZIP_NAME" "$origin/kiosk/$ZIP_NAME.sha256"; then
    return 0
  fi
  say "    $WHY"
  first="$WHY"
  version="$(release_version "$origin" || true)"
  if [ -z "$version" ]; then
    die "could not get the helper. $first. This server's version could not be read from $origin/api/update/status either, so the GitHub release was not tried."
  fi
  if try_source "the GitHub release v$version" "$GITHUB_BASE/v$version/$ZIP_NAME" "$GITHUB_BASE/v$version/$ZIP_NAME.sha256"; then
    return 0
  fi
  die "could not get the helper. $first. $WHY."
}

unpack_zip() {
  if command -v ditto >/dev/null 2>&1; then
    ditto -x -k "$1" "$2"
  else
    unzip -q "$1" -d "$2"
  fi
}

# Unpacked beside its destination, so the swap below is a rename on one volume,
# and checked before anything is touched.
stage_app() {
  mkdir -p "$APPS_DIR"
  STAGING="$APPS_DIR/.$APP_NAME.new.$$"
  rm -rf "$STAGING"
  mkdir -p "$STAGING"
  unpack_zip "$WORK/$ZIP_NAME" "$STAGING" || die "could not unpack $ZIP_NAME."
  [ -d "$STAGING/$APP_NAME" ] || die "$ZIP_NAME does not contain $APP_NAME."
  [ -x "$STAGING/$APP_NAME/Contents/MacOS/$APP_EXEC" ] || die "$ZIP_NAME holds no runnable $APP_EXEC."
  if ! grep -A1 '<key>CFBundleIdentifier</key>' "$STAGING/$APP_NAME/Contents/Info.plist" 2>/dev/null | grep -q "<string>$HELPER_LABEL</string>"; then
    die "the app in $ZIP_NAME is not $HELPER_LABEL."
  fi
}

# The old copy is moved aside, the new one renamed in, and the old one deleted
# only once the whole install has worked. Any failure until then, here or in a later
# step, puts the old one back.
swap_app() {
  OLD_APP="$APPS_DIR/.$APP_NAME.old.$$"
  rm -rf "$OLD_APP"
  if [ -d "$APPS_DIR/$APP_NAME" ]; then
    mv "$APPS_DIR/$APP_NAME" "$OLD_APP" || die "could not move the existing $APP_NAME aside; nothing was changed."
  else
    OLD_APP=""
  fi
  # From here a failure puts the old copy back and removes the new one; see roll_back.
  mv "$STAGING/$APP_NAME" "$APPS_DIR/$APP_NAME" ||
    die "could not put the new $APP_NAME in $APPS_DIR; the previous one is kept."
  APP_SWAPPED=1
}

# ── The agent that starts the helper at login ──────────────────────────────
# Never relaunch after a clean Quit from the app's window, always after a crash.
write_helper_plist() {
  cat >"$1" <<PLIST || die "could not write $1."
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$HELPER_LABEL</string>
  <key>ProgramArguments</key><array><string>/Applications/$APP_NAME/Contents/MacOS/$APP_EXEC</string></array>
  <key>AssociatedBundleIdentifiers</key><array><string>$HELPER_LABEL</string></array>
  <key>RunAtLoad</key><true/>
  <!-- Restarted if it crashes (a driver can take the process down), left alone
       when somebody quits it on purpose. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST
  # launchd refuses a LaunchAgent in /Library that is not root's.
  chown root:wheel "$1" || die "could not make $1 root-owned."
  chmod 644 "$1" || die "could not set the mode of $1."
}

stop_helper_agent() {
  [ -n "$CONSOLE_UID" ] || return 0
  if launchctl print "gui/$CONSOLE_UID/$HELPER_LABEL" >/dev/null 2>&1; then
    if launchctl bootout "gui/$CONSOLE_UID/$HELPER_LABEL"; then
      AGENT_STOPPED=1
      say "    stopped the running helper"
    else
      warn "could not stop the running helper through launchd"
    fi
  fi
  # A copy somebody opened by hand is not launchd's, and would hold the new
  # helper's place (a second launch hands over to the first). pgrep exits 1 when
  # there is none, which is the usual case.
  if pgrep -x -u "$CONSOLE_UID" "$APP_EXEC" >/dev/null 2>&1; then
    pkill -x -u "$CONSOLE_UID" "$APP_EXEC" || warn "could not stop a running copy of the helper"
    say "    stopped a copy that was running outside launchd"
  fi
}

start_helper_agent() {
  [ -n "$CONSOLE_UID" ] || return 0
  [ -f "$HELPER_PLIST" ] || return 0
  launchctl bootstrap "gui/$CONSOLE_UID" "$HELPER_PLIST"
}

# A system-wide LaunchAgent, so it loads at any GUI login and this needs no
# account, home folder or console user. It is started now only when someone is
# logged in to have a session for it.
install_helper_agent() {
  mkdir -p "$AGENT_DIR" || die "could not create $AGENT_DIR."
  if [ -f "$HELPER_PLIST" ]; then
    PLIST_BACKUP="$WORK/helper-plist.previous"
    cp -p "$HELPER_PLIST" "$PLIST_BACKUP" || die "could not keep a copy of $HELPER_PLIST."
  fi
  PLIST_WRITTEN=1
  write_helper_plist "$HELPER_PLIST"
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$HELPER_PLIST" >/dev/null || die "the LaunchAgent written to $HELPER_PLIST is not a valid property list."
  fi
  if [ -z "$CONSOLE_USER" ]; then
    say "    nobody is logged in at the console, so the helper was not started:"
    say "    it starts at the next login, whichever account that is"
    return 0
  fi
  # Through launchd rather than directly, so a crash is restarted and a logout
  # stops it.
  if launchctl bootstrap "gui/$CONSOLE_UID" "$HELPER_PLIST"; then
    AGENT_STARTED=1
    say "    started for $CONSOLE_USER; it also starts at every login"
  else
    warn "could not start the helper now; it starts at the next login"
  fi
}

# ── Moving off the Chrome kiosk ────────────────────────────────────────────
# The old agent and the helper must not both run on one Mac. The device id and
# token in the state directory are left exactly as they are: the Mac keeps its
# identity.
#
# Two steps, on either side of the helper's install, and the ORDER is the point.
# The helper reads the marker ONCE, when it launches, and gives the main display
# the kiosk's identity only when it first creates that output's record. Its agent
# loads (RunAtLoad) the moment it is bootstrapped, so a marker written after that
# can be missed by a fast launch, and the main display then has a fresh identity
# for good. So the marker is written before the helper is stopped, swapped in or
# started, and only the kiosk's own agent is removed after.
kiosk_present() {
  [ -e "$AGENT" ] || [ -e "$BIN" ]
}

plan_kiosk_migration() {
  kiosk_present || return 0
  say "==> Replacing the Chrome kiosk agent from an earlier install"
  MIGRATED=1
  would "write $MARKER, which tells the helper to give this Mac's main display the kiosk's screen, before the helper is started"
  would "once the helper is in: stop $KIOSK_LABEL for the console user, then remove $AGENT and $BIN"
  would "keep the device id, the token and the Chrome profile in $STATE_DIR"
}

# Step one. A failure to write it stops the install before anything has changed,
# so the kiosk keeps running rather than the Mac losing its screen with no word of
# why. Root-owned and world-readable: the helper only reads it. Written only for a
# Mac that has the kiosk's agent, so a fresh install never has one.
write_kiosk_marker() {
  kiosk_present || return 0
  say "==> Marking this Mac as coming from the Chrome kiosk"
  MIGRATED=1
  mkdir -p "$STATE_DIR" || die "could not create $STATE_DIR; nothing was changed."
  if [ -f "$MARKER" ]; then
    say "    $MARKER is already there"
    return 0
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ >"$MARKER" || die "could not write $MARKER; nothing was changed, and the Chrome kiosk is as it was."
  MARKER_CREATED=1
  chmod 644 "$MARKER" || die "could not set the mode of $MARKER; nothing was changed."
}

# Step two, after the helper's agent is in. Only the kiosk's agent goes here.
retire_kiosk() {
  kiosk_present || return 0
  say "==> Replacing the Chrome kiosk agent from an earlier install"
  # Kept until the end, so a failure from here on can put the kiosk back too.
  mkdir -p "$WORK/kiosk" || die "could not make room to keep the kiosk's files."
  if [ -e "$BIN" ]; then cp -p "$BIN" "$WORK/kiosk/launcher" || die "could not keep a copy of $BIN."; fi
  if [ -e "$AGENT" ]; then cp -p "$AGENT" "$WORK/kiosk/agent.plist" || die "could not keep a copy of $AGENT."; fi
  KIOSK_BACKED_UP=1
  if [ -n "$CONSOLE_UID" ] && launchctl print "gui/$CONSOLE_UID/$KIOSK_LABEL" >/dev/null 2>&1; then
    if launchctl bootout "gui/$CONSOLE_UID/$KIOSK_LABEL"; then
      KIOSK_STOPPED=1
      say "    stopped the running kiosk"
    else
      warn "could not stop the running Chrome kiosk; it stops at the next login"
    fi
  fi
  rm -f "$AGENT" "$BIN" || die "could not remove $AGENT and $BIN."
  say "    removed $AGENT and $BIN"
  say "    this Mac keeps its device id and its screen: the helper brings it back by itself"
  say "    on the main display. The Chrome profile in $STATE_DIR is left in place."
  if [ -z "$CONSOLE_USER" ]; then
    say "    Nobody is logged in, so the kiosk is replaced at the next login: the Chrome"
    say "    agent is gone and the helper's agent takes its place."
  fi
}

# ── What an output Mac needs ───────────────────────────────────────────────
as_user() {
  launchctl asuser "$CONSOLE_UID" sudo -u "$CONSOLE_USER" "$@"
}

set_power() {
  say "==> Keeping the displays awake"
  if [ "$DRY" -eq 1 ]; then
    would "pmset -a displaysleep 0 sleep 0"
    if [ -n "$CONSOLE_USER" ]; then
      would "screen saver idle time 0, and no password after it, for $CONSOLE_USER"
    else
      would "leave the screen saver alone: it is per account and nobody is logged in"
    fi
    return 0
  fi
  # Display sleep is the difference between a display and a black rectangle.
  if pmset -a displaysleep 0 sleep 0; then
    say "    display sleep and system sleep: never"
  else
    warn "pmset could not turn off display and system sleep; set both to Never in System Settings > Lock Screen"
  fi
  if [ -z "$CONSOLE_USER" ]; then
    warn "nobody is logged in, so the screen saver was not changed; it is a per-user setting"
    return 0
  fi
  # Per user, and per host for the idle time: run in the user's own session or the
  # write lands in a preferences daemon nobody reads.
  if as_user defaults -currentHost write com.apple.screensaver idleTime -int 0; then
    say "    screen saver: never ($CONSOLE_USER)"
  else
    warn "could not set the screen saver to never for $CONSOLE_USER; set it in System Settings > Lock Screen"
  fi
  # Newer macOS keeps this under a managed setting and may ignore the write; the
  # closing notes say to check it either way.
  as_user defaults write com.apple.screensaver askForPassword -int 0 ||
    warn "could not turn off the password after the screen saver for $CONSOLE_USER"
}

notes() {
  say
  if [ -z "$CONSOLE_USER" ]; then
    say "    Nobody is logged in, so the helper has not started: it starts at the next login."
  fi
  say "    Still to do at the Mac, once. macOS does not let a script do these:"
  say "      - System Settings > Users & Groups: set automatic login to this account."
  say "        The helper's browser needs a logged-in session."
  say "      - Answer the Local Network prompt when the helper first opens:"
  say "        \"Allow Stage Utility Output to find devices on local networks?\" -> Allow."
  say "        Without it the helper cannot find the server. It says so in its own window."
  say "      - System Settings > Lock Screen: \"Require password after screen saver"
  say "        begins or display is turned off\" -> Never, and check that the screen saver"
  say "        and display-off times read Never. This installer sets them where macOS"
  say "        accepts it; a managed Mac may ignore it."
  if [ "$MIGRATED" -eq 1 ]; then
    say "    This Mac's main display comes back as the screen the Chrome kiosk showed. Its"
    say "    other displays are listed under \"Not set up yet\" in Screens."
  else
    say "    Then open Screens in Stage Utility: this Mac's displays are listed under"
    say "    \"Not set up yet\". The Mac's main display (the one with the menu bar) is off"
    say "    until you switch it on in the helper's window."
  fi
}

# ── The two installs ───────────────────────────────────────────────────────
install_helper() {
  say "==> Installing the Stage Utility Output helper"
  detect_arch
  say "    this Mac: $ARCH"
  find_console_user
  write_state

  if [ "$DRY" -eq 1 ]; then
    origin="$(server_origin)"
    [ -n "$origin" ] || no_server_address
    would "download $origin/kiosk/StageUtilityOutput-$ARCH.zip and its .sha256"
    would "failing that, ask $origin/api/update/status for its version and download the GitHub release's StageUtilityOutput-$ARCH.zip"
    would "refuse a zip whose SHA-256 differs from the published one"
    would "unpack beside $APPS_DIR/$APP_NAME, check it is $HELPER_LABEL, then swap it in, keeping the old copy until that worked"
    would "write $HELPER_PLIST, root-owned, which starts the helper at every login"
    if [ -n "$CONSOLE_USER" ]; then
      would "start the helper now for $CONSOLE_USER"
    else
      would "nobody is logged in, so the helper starts at the next login"
    fi
    plan_kiosk_migration
    set_power
    notes
    say
    say "==> Dry run: nothing was changed."
    return 0
  fi

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/stage-utility-output.XXXXXX")"
  fetch_helper
  stage_app
  # Everything above has changed nothing on this Mac. The marker is the first
  # change, and it comes before the helper can possibly launch; see the note on
  # the Chrome kiosk below.
  write_kiosk_marker
  stop_helper_agent
  swap_app
  say "    installed $APPS_DIR/$APP_NAME"
  install_helper_agent
  retire_kiosk
  # Done: nothing after this is undone by a failure. set_power only warns.
  FINISHED=1
  set_power
  say
  say "==> Done. This Mac is device $(cat "$STATE_DIR/device-id")"
  notes
}

# Today's Chrome kiosk.
install_browser() {
  echo "==> Installing the Stage Utility kiosk agent"
  find_console_user

  if [ "$DRY" -eq 1 ]; then
    write_state
    would "write the launcher $BIN"
    would "write the LaunchAgent $AGENT"
    would "pmset -a displaysleep 0 sleep 0"
    return 0
  fi

  write_state

  # ── The launcher ────────────────────────────────────────────────────────
  mkdir -p "$(dirname "$BIN")"
  cat >"$BIN" <<LAUNCHER
#!/usr/bin/env bash
set -u
STATE_DIR="$STATE_DIR"
PORT=$PORT

ID="\$(cat "\$STATE_DIR/device-id")"
TOKEN="\$(cat "\$STATE_DIR/token" 2>/dev/null || true)"
BOUND_FILE="\$STATE_DIR/bound-to"

macs() {
  ifconfig 2>/dev/null | awk '/ether /{printf "\\"%s\\",", \$2}' | sed 's/,\$//'
}

# nc, not socat: it ships with macOS, so this adds no dependency. -w2 gives the
# server two seconds to answer before we try again.
#
# NOT \`nc -b\`. On macOS -b is the INTERFACE flag, not a broadcast switch, so
# \`nc -u -w2 -b 255.255.255.255\` dies with "nc: bad interface name" and never
# sends anything. \`| head -c 2048\` then swallowed the failure, discover() always
# returned empty, and the loop below spun for ever -- a Mac kiosk without
# STAGE_SERVER preset never displayed anything at all.
#
# Each interface's own broadcast address, from ifconfig, with 255.255.255.255 as
# a last resort. A directed broadcast is what actually crosses a macOS interface
# without SO_BROADCAST gymnastics, and enumerating them also covers a Mac with
# more than one network up -- which a booth machine on wired plus wifi is.
bcast_targets() {
  ifconfig 2>/dev/null | awk '/broadcast/ { print \$NF }' | sort -u
  echo 255.255.255.255
}

discover() {
  bound="\$(cat "\$BOUND_FILE" 2>/dev/null || true)"
  probe="{\"stageUtility\":\"discover\",\"v\":1,\"id\":\"\$ID\",\"macs\":[\$(macs)],\"hostname\":\"\$(hostname -s)\",\"os\":\"macOS\""
  [ -n "\$bound" ] && probe="\$probe,\"boundTo\":\"\$bound\""
  probe="\$probe}"
  for target in \$(bcast_targets); do
    reply="\$(printf '%s' "\$probe" | nc -u -w2 "\$target" \$PORT 2>/dev/null | head -c 2048)"
    if [ -n "\$reply" ]; then
      printf '%s' "\$reply"
      return 0
    fi
  done
  return 0
}

if [ -r "\$STATE_DIR/server" ]; then
  URL="\$(cat "\$STATE_DIR/server")"
else
  URL=""; fails=0
  while [ -z "\$URL" ]; do
    reply="\$(discover)"
    URL="\$(printf '%s' "\$reply" | sed -n 's/.*"url":"\\([^"]*\\)".*/\\1/p')"
    SRV="\$(printf '%s' "\$reply" | sed -n 's/.*"serverId":"\\([^"]*\\)".*/\\1/p')"
    [ -n "\$SRV" ] && printf '%s' "\$SRV" > "\$BOUND_FILE"
    if [ -z "\$URL" ]; then
      fails=\$((fails + 1))
      [ "\$fails" -lt 10 ] && sleep 2 || sleep 30
    fi
  done
fi

TARGET="\$URL/enroll?device=\$ID"
[ -n "\$TOKEN" ] && TARGET="\$TARGET&token=\$TOKEN"

# Chrome if it is here, Safari if not. Chrome has a real kiosk mode; Safari is
# opened fullscreen and is the fallback rather than the choice.
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
    --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \\
    --user-data-dir="\$STATE_DIR/chrome" "\$TARGET"
else
  exec open -a Safari "\$TARGET"
fi
LAUNCHER
  chmod +x "$BIN"

  # ── Survive a reboot, and a browser that dies ────────────────────────────
  # A LaunchAgent, not a Daemon: this needs a logged-in GUI session to put a window
  # on a screen, which is also why automatic login is a prerequisite.
  mkdir -p "$AGENT_DIR"
  cat >"$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$KIOSK_LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>RunAtLoad</key><true/>
  <!-- The browser exiting is the cue to re-discover, which is how a screen
       recovers when the server's address changed. -->
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
  chmod 644 "$AGENT"

  # Display sleep is the difference between a display and a black rectangle. The
  # screen saver is per-user and not scriptable -- see the note at the top.
  pmset -a displaysleep 0 sleep 0 2>/dev/null || true

  if [ -d "$APPS_DIR/$APP_NAME" ]; then
    echo
    echo "    Note: the Stage Utility Output helper is still installed on this Mac, and"
    echo "    both would show on its display. To remove the helper:"
    echo "      launchctl bootout gui/<uid>/$HELPER_LABEL; rm -rf \"/Applications/$APP_NAME\""
  fi

  echo
  echo "==> Done. This screen is device $(cat "$STATE_DIR/device-id")"
  echo "    It starts at the next login. Open Screens in Stage Utility and set"
  echo "    it up under \"Not set up yet\"."
  echo
  echo "    Still to do by hand, once: enable automatic login, and set the screen"
  echo "    saver to Never. Neither can be set from a script."
}

main() {
  for arg in "$@"; do
    case "$arg" in
      --browser) MODE=browser ;;
      --dry-run) DRY=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        warn "unknown option \"$arg\" (try --help)"
        exit 2
        ;;
    esac
  done

  # A hang-up or Ctrl-C ends the script through the EXIT trap, so it rolls back too.
  trap 'exit 1' HUP INT TERM
  trap on_exit EXIT
  check_macos
  if [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
    die "run with sudo — the device id lives outside your home directory so a profile reset cannot cost you a claim."
  fi

  if [ "$MODE" = browser ]; then
    install_browser
  else
    install_helper
  fi
}

# The tests source this file to drive the functions above.
if [ -z "${STAGE_INSTALL_SOURCED:-}" ]; then
  main "$@"
fi
