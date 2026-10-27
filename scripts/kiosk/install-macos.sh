#!/bin/sh
# Turn this Mac into Stage Utility screens.
#
#   curl -fsSL http://<server>/kiosk/install-macos.sh | sudo sh
#
# By default this installs the Stage Utility Output helper (macOS 14 or later): a
# menu bar app that makes each of the Mac's displays, and each DeckLink port, a
# screen device of its own. It downloads the app from this server, falls back to
# the GitHub release for the server's version, checks the release's SHA-256, puts it
# in /Applications and starts it at login, for whichever account logs in.
#
#   --browser    the earlier Chrome kiosk instead: one full-screen browser. For a
#                Mac the helper cannot run on.
#                curl -fsSL http://<server>/kiosk/install-macos.sh | sudo sh -s -- --browser
#   --dry-run    print every step and change nothing. Needs no sudo.
#   --check-update
#                what the updater this installs runs every five minutes, as root:
#                ask the server whether to update the helper, and do it. Not for
#                typing; see "Updating itself" below.
#   --help       this text
#
#   STAGE_DOWNLOAD_FROM=http://<server>
#                                  where to download the helper from. The Mac is not
#                                  pinned to it (the helper still finds its server by
#                                  discovery), but the updater asks it from then on,
#                                  as it asks whichever server an install came from.
#   STAGE_SERVER=http://<server>   a separate choice: pin this Mac to that server.
#                                  Written to the `server` file, which skips
#                                  discovery for good, so the Mac will not follow the
#                                  server if it moves. Set it only where broadcast
#                                  does not cross. It is also where this run downloads
#                                  from, unless STAGE_DOWNLOAD_FROM names another.
#   STAGE_KIOSK_PORT=8789          the discovery port of the Chrome kiosk
#
# Running it again upgrades in place. It never mints a second device id.
#
# Updating itself: the helper install also puts a copy of this script in
# /Library/Application Support/StageUtilityUpdater and a LaunchDaemon,
# com.stageutility.output-updater, that runs it with --check-update every five
# minutes. That asks the server whether to update (the server decides: never while a
# service is live or near one), downloads and verifies the new app exactly as an
# install does, swaps it in keeping the old one, restarts the helper, and puts the
# old one back if the new one does not say it started. It never runs anything it
# downloaded as root: it swaps the app, which runs as the logged-in user. A change to
# this script itself reaches a Mac only when the installer is run again by hand.
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
# SERVER is written to the `server` file and pins the Mac to it; DOWNLOAD_FROM only
# says where this run downloads the app from and is never saved.
SERVER="${STAGE_SERVER:-}"
DOWNLOAD_FROM="${STAGE_DOWNLOAD_FROM:-}"

APP_NAME=StageUtilityOutput.app
APP_EXEC=StageUtilityOutput
HELPER_LABEL=com.stageutility.output
# System-wide, like the Chrome kiosk's agent: root-owned, loaded at any GUI login,
# so it needs no account to exist when this runs.
HELPER_PLIST="$AGENT_DIR/$HELPER_LABEL.plist"
# The repository is also spelled in main/services/github-repo.ts and the other installers.
GITHUB_BASE="${STAGE_INSTALL_GITHUB_BASE:-https://github.com/Cornerstone-Production/Stage-Utility/releases/download}"
# A release's JSON, which carries each asset's SHA-256. The release publishes no
# .sha256 file of its own; only the server serves one, built from this digest.
GITHUB_API="${STAGE_INSTALL_GITHUB_API:-https://api.github.com/repos/Cornerstone-Production/Stage-Utility/releases/tags}"

# The updater: root-owned, apart from STATE_DIR, which the console user owns and so
# could plant a script in. Its copy of this script, the server it was installed from,
# and what it last did, in `status`.
UPDATER_LABEL=com.stageutility.output-updater
UPDATER_DIR="$ROOT/Library/Application Support/StageUtilityUpdater"
UPDATER_SCRIPT="$UPDATER_DIR/install-macos.sh"
UPDATER_ORIGIN="$UPDATER_DIR/server"
UPDATER_STATUS="$UPDATER_DIR/status"
UPDATER_PLIST="$ROOT/Library/LaunchDaemons/$UPDATER_LABEL.plist"
UPDATE_LOG="$ROOT/Library/Logs/StageUtility/helper-update.log"
UPDATE_EVERY=300
# What the helper writes for the updater (HelperStatus.swift), in the logged-in
# user's home. Both names are checked against the Swift (InstallerContractTests).
HELPER_USER_DIR="Library/Application Support/StageUtilityOutput"
HELPER_STATUS_NAME=helper-status.json
# How long a new helper has to say it started before the old one goes back, and
# how long a rolled-back one has to be running again.
START_TIMEOUT="${STAGE_INSTALL_TEST_START_TIMEOUT:-90}"
RESTART_WAIT="${STAGE_INSTALL_TEST_RESTART_WAIT:-20}"
# One install or update at a time: see take_lock.
UPDATE_LOCK="$UPDATER_DIR/lock"

# The ceiling on one zip download, seconds. The server's own fetch of the zip from
# GitHub may take up to two hours (its watchdog's ceiling, in
# main/services/output-helper-download.ts), during which it sends this script
# nothing, and then it sends the zip. Ten minutes of margin on top of the two hours.
ZIP_CEILING=7800

MODE=helper
DRY=0
# Set in --check-update: the update in progress, so a failure records itself;
# whether a failure from here holds that version (see record_update_failure);
# whether a signal ended the run; and what the status file carries alongside.
UPDATING=""
UPDATE_FAILED=""
HOLD=0
INTERRUPTED=0
LOCKED=0
ST_AT=""
ST_RETRY=""
ST_FAILS=0
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

# In --check-update every line goes to the updater's log file (launchd's stdout and
# stderr), so it carries the time and the tag a person greps for.
stamp() {
  if [ "$MODE" = check ]; then printf '%s [helper-update] ' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; fi
}
say() { printf '%s%s\n' "$(stamp)" "$*"; }
warn() { printf '%sinstall-macos.sh: %s\n' "$(stamp)" "$*" >&2; }
die() {
  warn "$*"
  UPDATE_FAILED="$*"
  exit 1
}
# What a dry run would have done.
would() { printf '    [dry-run] %s\n' "$*"; }

usage() {
  cat <<'USAGE'
Usage: install-macos.sh [--browser] [--dry-run] [--check-update]

  (default)   install the Stage Utility Output helper (macOS 14 or later), and
              the updater that keeps it on the server's version
  --browser   install the Chrome kiosk instead
  --dry-run   print every step and change nothing; needs no sudo
  --check-update
              what the updater runs every five minutes; not for typing
  --help      this text

Run as root: curl -fsSL http://<server>/kiosk/install-macos.sh | sudo sh
Options go after -s --:  ... | sudo sh -s -- --dry-run
STAGE_DOWNLOAD_FROM=http://<server> names the server to download from; the updater then asks it too.
STAGE_SERVER=http://<server> pins this Mac to a server (see the top of this file).
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
    # After the roll back, so what it says is what the Mac has now.
    if [ -n "$UPDATING" ]; then record_update_failure; fi
  elif [ -n "$OLD_APP" ]; then
    rm -rf "$OLD_APP"
  fi
  if [ -n "$STAGING" ]; then rm -rf "$STAGING"; fi
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  release_lock
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

# ── Writing as root into a directory somebody else owns ────────────────────
# The state directory is handed to the console user (the Chrome kiosk writes its
# binding and profile there), so that user can leave a symbolic link in it. A root
# `>file` or `chmod` through a link to /etc/anything would then clobber or loosen
# it. Four files are written as root there: the marker, `server`, `device-id` and
# `token`. A link where one is to be written is removed first (rm -f takes the
# link, not what it points at), and the write is exclusive (noclobber is O_EXCL, so
# it cannot be made to follow a link planted after the removal). One already
# there that must be kept, an identity file, is refused rather than replaced: a
# link in its place means the directory was tampered with, and the id is a claim.
# put_file DEST MODE, the content on stdin.
put_file() {
  rm -f "$1" || return 1
  (
    set -C
    cat >"$1"
  ) || return 1
  chmod "$2" "$1"
}

refuse_link() {
  if [ -L "$1" ]; then
    die "$1 is a symbolic link, which this installer will not write through as root. Remove it and run the installer again."
  fi
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
  refuse_link "$STATE_DIR/device-id"
  refuse_link "$STATE_DIR/token"
  if [ ! -f "$STATE_DIR/device-id" ]; then
    new_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    [ -n "$new_id" ] || die "could not make a device id (uuidgen printed nothing)."
    printf '%s\n' "$new_id" | put_file "$STATE_DIR/device-id" 644 || die "could not write $STATE_DIR/device-id."
  fi
  # The device's own secret: pinned by the server the first time it is claimed.
  if [ ! -f "$STATE_DIR/token" ]; then
    new_token="$(head -c 24 /dev/urandom | xxd -p | tr -d '\n')"
    [ -n "$new_token" ] || die "could not make a token."
    printf '%s' "$new_token" | put_file "$STATE_DIR/token" 600 || die "could not write $STATE_DIR/token."
  fi
  if [ -n "$SERVER" ]; then
    printf '%s' "$SERVER" | put_file "$STATE_DIR/server" 644 || die "could not write $STATE_DIR/server."
  fi
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
# Where the server is, for the download: the operator's STAGE_DOWNLOAD_FROM, else
# their STAGE_SERVER, else the address this script was served from, else the server
# file of an earlier install. Empty when none of them is known.
server_origin() {
  if [ -n "$DOWNLOAD_FROM" ]; then
    printf '%s' "$DOWNLOAD_FROM"
  elif [ -n "$SERVER" ]; then
    printf '%s' "$SERVER"
  elif [ -n "$FETCHED_FROM" ]; then
    printf '%s' "$FETCHED_FROM"
  elif [ -r "$STATE_DIR/server" ]; then
    tr -d '\r\n' <"$STATE_DIR/server"
  fi
}

no_server_address() {
  die "no server address to download from. Run the command from the server's Settings page, or name the server for this download only: sudo STAGE_DOWNLOAD_FROM=http://<server> sh install-macos.sh (STAGE_SERVER=http://<server> also works, but it pins this Mac to that server for good and skips discovery, which is a separate choice)."
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
  idle="${5:-0}"
  HTTP_CODE=""
  rc=0
  # IDLE seconds below 1 KB/s ends the transfer, when IDLE is not 0; MAX is the
  # ceiling on the whole of it either way.
  speed=""
  if [ "$idle" -gt 0 ]; then speed="--speed-time $idle --speed-limit 1024"; fi
  # A progress bar for the zip; silent, but still saying why it failed, for the rest.
  output="-sS"
  if [ "$progress" -eq 1 ]; then output="-#"; fi
  # shellcheck disable=SC2086 # $output and $speed are flags and their values, meant to split
  HTTP_CODE="$(curl $output -L --connect-timeout 10 --max-time "$max" $speed -o "$dest" -w '%{http_code}' "$url")" || rc=$?
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

# The digest a release's JSON lists for the zip, or nothing. The same extraction as
# release_digest in install.sh, which says why it is written this way (and why there
# is no {64}); scripts/kiosk-install-macos.test.ts runs both over the same fixtures.
digest_from_release() {
  awk -v want="\"name\": \"$ZIP_NAME\"" '
    /"name": "/ { found = (index($0, want) > 0); next }
    found && /"digest": "sha256:/ {
      line = $0
      sub(/.*sha256:/, "", line)
      sub(/[^0-9a-f].*$/, "", line)
      if (length(line) == 64) { print line; exit }
    }
  ' "$1"
}

# The two ways to learn what the zip must hash to. Each sets `expected`, or returns
# non-zero with the reason in WHY, which starts with the source's LABEL.
#
# The server serves a checksum line (the first field of the first line):
expected_from_server() {
  label="$1"
  WHY=""
  rm -f "$WORK/checksum"
  if ! fetch_to "$2" "$WORK/checksum" 60 0; then
    WHY="$label: the checksum $WHY"
    return 1
  fi
  expected="$(awk 'NR == 1 { print tolower($1) }' "$WORK/checksum")"
  expected_is_a_digest "$label"
}

# The release publishes no checksum file; its API lists a digest per asset.
expected_from_release() {
  label="$1"
  WHY=""
  rm -f "$WORK/release.json"
  if ! fetch_to "$2" "$WORK/release.json" 60 0; then
    case "$HTTP_CODE" in
      403 | 429) WHY="$WHY (GitHub may have rate-limited this network: 60 requests an hour without a token)" ;;
    esac
    WHY="$label: the release record $WHY"
    return 1
  fi
  expected="$(digest_from_release "$WORK/release.json")"
  if [ -z "$expected" ]; then
    WHY="$label: the release record lists no SHA-256 for $ZIP_NAME (the release may predate GitHub's asset digests, which began in 2025, or the record is not in the form this installer reads)"
    return 1
  fi
  expected_is_a_digest "$label"
}

# One shape check for both: exactly 64 lowercase hex digits, and nothing else.
expected_is_a_digest() {
  if printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then return 0; fi
  WHY="$1: the checksum is not a SHA-256 digest"
  return 1
}

# One download source, after `expected` is known: the zip, then the comparison.
# Returns non-zero with the reason in WHY, and leaves no zip it would trust behind.
try_source() {
  label="$1"
  zip_url="$2"
  zip_idle="$3"
  rm -f "$WORK/$ZIP_NAME"
  say "    downloading $ZIP_NAME from $label"
  say "    (a server that has not fetched it yet downloads it from GitHub first; that can take a few minutes)"
  # A progress bar for a person; none in the updater's log file.
  bar=1
  if [ "$MODE" = check ]; then bar=0; fi
  if ! fetch_to "$zip_url" "$WORK/$ZIP_NAME" "$ZIP_CEILING" "$bar" "$zip_idle"; then
    WHY="$label: the download $WHY"
    return 1
  fi
  actual="$(sha256_of "$WORK/$ZIP_NAME")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$WORK/$ZIP_NAME"
    WHY="$label: the download did not match the release's SHA-256 (expected $expected, got $actual)"
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
  # No idle limit on the server: a server that has not fetched the zip yet sends
  # nothing until it has all of it from GitHub, which curl would count as idle.
  label="this server ($origin)"
  if expected_from_server "$label" "$origin/kiosk/$ZIP_NAME.sha256" && try_source "$label" "$origin/kiosk/$ZIP_NAME" 0; then
    return 0
  fi
  say "    $WHY"
  first="$WHY"
  version="$(release_version "$origin" || true)"
  if [ -z "$version" ]; then
    die "could not get the helper. $first. This server's version could not be read from $origin/api/update/status either, so the GitHub release was not tried."
  fi
  label="the GitHub release v$version"
  if expected_from_release "$label" "$GITHUB_API/v$version" && try_source "$label" "$GITHUB_BASE/v$version/$ZIP_NAME" 60; then
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
  clear_setid "$STAGING" || die "could not clear set-user-id bits in the unpacked $APP_NAME."
}

# Unpacked as root, so a set-user-id bit in the zip would be a root program for
# anyone at the Mac. The app needs none. find does not follow links. (ditto keeps
# the bit only for root, so a test cannot see it through a zip: it calls this.)
clear_setid() {
  find "$1" -type f \( -perm -4000 -o -perm -2000 \) -exec chmod ug-s {} +
}

# CFBundleShortVersionString of an app's Info.plist, which build-app.sh writes as
# XML: the key, then the string on the next line or the same one. Empty when there
# is none.
app_version() {
  plist="$1/Contents/Info.plist"
  [ -r "$plist" ] || return 0
  tr -d '\n' <"$plist" | sed -n 's:.*<key>CFBundleShortVersionString</key>[[:space:]]*<string>\([^<]*\)</string>.*:\1:p'
}

# The old copy is moved aside, the new one renamed in, and the old one deleted
# only once the whole install has worked. Any failure until then, here or in a later
# step, puts the old one back.
swap_app() {
  OLD_APP="$APPS_DIR/.$APP_NAME.old.$$"
  rm -rf "$OLD_APP"
  if [ -d "$APPS_DIR/$APP_NAME" ]; then
    mv "$APPS_DIR/$APP_NAME" "$OLD_APP" || die "could not move the existing $APP_NAME aside; nothing else was changed. The device id and token already written are kept."
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
  mkdir -p "$STATE_DIR" || die "could not create $STATE_DIR; nothing else was changed. The device id and token already written are kept."
  if [ -f "$MARKER" ] && [ ! -L "$MARKER" ]; then
    say "    $MARKER is already there"
    return 0
  fi
  MARKER_CREATED=1
  date -u +%Y-%m-%dT%H:%M:%SZ | put_file "$MARKER" 644 || die "could not write $MARKER; nothing else was changed, and the Chrome kiosk is as it was. The device id and token already written are kept."
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

# ── The updater ────────────────────────────────────────────────────────────
# Installed with the helper, after it: the helper works without it, so a failure
# here is said plainly and the install still stands. Run the installer again to
# retry.
write_updater_plist() {
  cat >"$1" <<PLIST || return 1
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$UPDATER_LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>/Library/Application Support/StageUtilityUpdater/install-macos.sh</string><string>--check-update</string></array>
  <!-- Every five minutes, and once at boot. launchd never starts a second run
       while one is still going, so a long download cannot overlap the next. -->
  <key>StartInterval</key><integer>$UPDATE_EVERY</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Library/Logs/StageUtility/helper-update.log</string>
  <key>StandardErrorPath</key><string>/Library/Logs/StageUtility/helper-update.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST
  chown root:wheel "$1" && chmod 644 "$1"
}

# The copy of this script the daemon runs. From the file this run is reading when
# there is one (sh install-macos.sh), else from the server, as `curl | sh` leaves
# nothing on disk to copy.
copy_updater_script() {
  if [ -f "$0" ] && grep -q '^UPDATER_LABEL=' "$0" 2>/dev/null; then
    cp "$0" "$UPDATER_SCRIPT.new" || return 1
  else
    origin="$(server_origin)"
    [ -n "$origin" ] || return 1
    fetch_to "${origin%/}/kiosk/install-macos.sh" "$UPDATER_SCRIPT.new" 60 0 || return 1
  fi
  # Only something this script would run: it parses, and it is this updater.
  if ! sh -n "$UPDATER_SCRIPT.new" || ! grep -q '^UPDATER_LABEL=' "$UPDATER_SCRIPT.new"; then return 1; fi
  chown root:wheel "$UPDATER_SCRIPT.new" && chmod 755 "$UPDATER_SCRIPT.new" && mv -f "$UPDATER_SCRIPT.new" "$UPDATER_SCRIPT"
}

# Everything install_updater writes, failing with the reason in WHY.
updater_files() {
  # The server it will ask: the one this install downloaded from, which it printed
  # (STAGE_SERVER, the pin, when one was given). Copied into root's folder, as is
  # the device id, because the updater runs as root and the state folder is the
  # console user's: a `server` file found there later is not the updater's to follow.
  origin="$(server_origin)"
  origin="${origin%/}"
  [ -n "$origin" ] || { WHY="no server address to ask"; return 1; }
  is_origin "$origin" || { WHY="$origin is not a server address (http://<host>:<port>, nothing after it)"; return 1; }
  if [ ! -f "$STATE_DIR/device-id" ] || [ -L "$STATE_DIR/device-id" ]; then
    WHY="$STATE_DIR/device-id is missing or a link"
    return 1
  fi
  machine="$(tr -d '\r\n' <"$STATE_DIR/device-id")"
  printf '%s\n' "$machine" | grep -Eq '^[A-Za-z0-9._-]{1,128}$' || { WHY="$STATE_DIR/device-id is not a device id"; return 1; }
  [ ! -L "$UPDATER_DIR" ] || { WHY="$UPDATER_DIR is a symbolic link"; return 1; }
  mkdir -p "$UPDATER_DIR" "$(dirname "$UPDATE_LOG")" "$(dirname "$UPDATER_PLIST")" || { WHY="could not create $UPDATER_DIR"; return 1; }
  if ! chown root:wheel "$UPDATER_DIR" || ! chmod 755 "$UPDATER_DIR"; then
    WHY="could not make $UPDATER_DIR root's"
    return 1
  fi
  copy_updater_script || { WHY="could not put a copy of this installer in $UPDATER_DIR${WHY:+ ($WHY)}"; return 1; }
  printf '%s\n' "$origin" | put_file "$UPDATER_ORIGIN" 644 || { WHY="could not write $UPDATER_ORIGIN"; return 1; }
  printf '%s\n' "$machine" | put_file "$UPDATER_DIR/device-id" 644 || { WHY="could not write $UPDATER_DIR/device-id"; return 1; }
  write_updater_plist "$UPDATER_PLIST" || { WHY="could not write $UPDATER_PLIST"; return 1; }
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$UPDATER_PLIST" >/dev/null || { WHY="$UPDATER_PLIST is not a valid property list"; return 1; }
  fi
}

install_updater() {
  say "==> Installing the updater, so this helper follows the server's version"
  WHY=""
  if ! updater_files; then
    rm -f "$UPDATER_SCRIPT.new"
    warn "automatic updates are NOT installed: ${WHY:-could not write the updater}. The helper is installed and works; run this installer again to add them."
    return 0
  fi
  if launchctl print "system/$UPDATER_LABEL" >/dev/null 2>&1; then
    launchctl bootout "system/$UPDATER_LABEL" || warn "could not stop the updater that was running; the new one starts at the next boot"
  fi
  if launchctl bootstrap system "$UPDATER_PLIST"; then
    say "    it asks $(cat "$UPDATER_ORIGIN") every five minutes whether to update, and never"
    say "    during a service. Its log: /Library/Logs/StageUtility/helper-update.log"
  else
    warn "the updater is installed but could not be started; it starts at the next boot"
  fi
}

# ── --check-update ─────────────────────────────────────────────────────────
# Root runs this. What it acts on is root's own: the device id and the server in
# UPDATER_DIR, copied there at install. The state folder, which the console user
# owns, is never read here, and the user's home only for the helper's status file,
# and then only a regular file that user owns, never a link.

# One field of the updater's status file (key=value lines), or empty.
status_field() {
  [ -r "$UPDATER_STATUS" ] || return 0
  sed -n "s/^$1=//p" "$UPDATER_STATUS" | head -n 1
}

# What the updater did, for the next check to tell the server: one line each, and
# none of them may hold a newline. ST_AT (when it happened, unix seconds),
# ST_RETRY (when a download that failed may be tried again) and ST_FAILS (how many
# have failed in a row) ride along.
write_status() { # state target detail answer
  {
    printf 'state=%s\n' "$1"
    printf 'target=%s\n' "$2"
    printf 'detail=%s\n' "$(printf '%s' "$3" | tr '\r\n' '  ' | cut -c 1-200)"
    printf 'answer=%s\n' "$(printf '%s' "$4" | tr '\r\n' '  ' | cut -c 1-300)"
    printf 'at=%s\n' "$ST_AT"
    printf 'retry_after=%s\n' "$ST_RETRY"
    printf 'fails=%s\n' "$ST_FAILS"
  } | put_file "$UPDATER_STATUS" 644 || warn "could not write $UPDATER_STATUS"
}

# The logged-in user's home, where the helper writes its status.
console_home() {
  if [ -n "${STAGE_INSTALL_TEST_HOME:-}" ]; then
    printf '%s' "$STAGE_INSTALL_TEST_HOME"
    return 0
  fi
  [ -n "$CONSOLE_USER" ] || return 0
  dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{ print $2 }'
}

helper_status_file() {
  home="$(console_home)"
  [ -n "$home" ] && printf '%s/%s/%s' "$home" "$HELPER_USER_DIR" "$HELPER_STATUS_NAME"
}

# One field of a one-line JSON object: helper-status.json, which
# HelperStatus.encoded() writes with sorted keys, or the server's answer. A string
# comes back without its quotes and with any escape left as it is (\" stays \"),
# commas and all: the server's sentences have them. Anything else (a number, a
# bool) comes back as written.
json_field() { # file key
  if [ ! -r "$1" ] || [ -L "$1" ]; then return 0; fi
  flat="$(tr -d '\n' <"$1")"
  value="$(printf '%s' "$flat" | sed -nE "s/.*\"$2\":\"(([^\"\\\\]|\\\\.)*)\".*/\1/p" | head -n 1)"
  if [ -z "$value" ]; then
    value="$(printf '%s' "$flat" | sed -nE "s/.*\"$2\":([^\",}]+)[,}].*/\1/p" | head -n 1)"
  fi
  printf '%s' "$value"
}

# One field of the helper's status file, read only when it is a regular file the
# logged-in user owns: root following a link, or reading a file somebody else put
# there, would read whatever it was pointed at.
helper_field() { # key
  file="$(helper_status_file || true)"
  # find looks at a link itself, not what it points at, so -type f refuses one.
  if [ -z "$file" ] || [ -z "$(find "$file" -prune -type f -user "$CONSOLE_UID" 2>/dev/null)" ]; then return 0; fi
  json_field "$file" "$1"
}

# launchd's pid for the helper in the console user's session, or empty.
helper_pid() {
  launchctl print "gui/$CONSOLE_UID/$HELPER_LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }'
}

# A server root and nothing else: http(s), then exactly the host and port HOST_RE
# in main/services/kiosk-installer-origin.ts admits. The same pattern is
# $OriginPattern in kiosk-update-windows.ps1 and install-windows.ps1;
# scripts/origin-shape.test.ts runs all four against one list.
is_origin() {
  printf '%s\n' "$1" | grep -Eq '^https?://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\])(:[0-9]{1,5})?$'
}

# The server to ask: the one recorded at install, root's own copy. Never the state
# folder's `server` file, nor the server the helper says it loads from: the
# logged-in user can write both, and root installs what this server sends.
update_server() {
  if [ ! -r "$UPDATER_ORIGIN" ] || [ -L "$UPDATER_ORIGIN" ]; then return 0; fi
  origin="$(tr -d '\r\n' <"$UPDATER_ORIGIN")"
  if is_origin "${origin%/}"; then printf '%s' "${origin%/}"; fi
}

# Record this check's answer (the server's reason, or why there was none), and say
# it only when it differs from the last one: a check every five minutes must not
# be a log line every five minutes.
settle() { # answer message state target detail
  if [ "$1" != "$(status_field answer)" ]; then say "$2"; fi
  write_status "$3" "$4" "$5" "$1"
}

# Ask the server. Leaves the answer in $WORK/answer and returns 0 on a 200.
ask_server() { # origin have state target detail
  code="$(curl -sS -G --connect-timeout 10 --max-time 30 -o "$WORK/answer" -w '%{http_code}' \
    --data-urlencode "machine=$MACHINE" --data-urlencode "platform=macos" \
    --data-urlencode "have=$2" --data-urlencode "host=$HOST_NAME" --data-urlencode "state=$3" \
    --data-urlencode "target=$4" --data-urlencode "detail=$5" --data-urlencode "at=$ST_AT" \
    "$1/api/machine-updates/check" 2>/dev/null)" || return 1
  [ "$code" = 200 ]
}

# Wait for the helper launchd started to say it is the new one and its Chromium
# started. Sets WHY and returns 1 when it does not.
wait_for_helper() { # version
  [ -n "$(helper_status_file || true)" ] || { WHY="could not find $CONSOLE_USER's home folder to read whether the new helper started"; return 1; }
  waited=0
  while [ "$waited" -lt "$START_TIMEOUT" ]; do
    pid="$(helper_pid)"
    if [ -n "$pid" ] && [ "$(helper_field pid)" = "$pid" ] && [ "$(helper_field version)" = "$1" ]; then
      if [ "$(helper_field chromium)" = started ]; then return 0; fi
      WHY="Chromium did not start: $(helper_field chromiumProblem)"
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  WHY="the new helper did not say it started within $START_TIMEOUT s"
  return 1
}

# After a roll back: the previous helper is running again, or is made to be. A Mac
# that auto-logs in has no next login to start it at.
helper_came_back() {
  waited=0
  while [ "$waited" -lt "$RESTART_WAIT" ]; do
    [ -z "$(helper_pid)" ] || return 0
    if [ "$waited" -eq $((RESTART_WAIT / 2)) ]; then launchctl kickstart "gui/$CONSOLE_UID/$HELPER_LABEL" >/dev/null 2>&1 || true; fi
    sleep 1
    waited=$((waited + 1))
  done
  [ -n "$(helper_pid)" ]
}

# From on_exit, after the roll back: what failed, and what the Mac runs now.
#
# A failure that is the version's (it would not start, the server sent the wrong
# one, it is not the helper) holds that version until someone presses Try again. A
# failure that is not (the download failed, the Mac shut down mid-update) is tried
# again later, after half an hour, then an hour, up to six hours apart: a version
# must not be shut out by a night without internet, and a download that keeps
# failing must not be 145 MB every five minutes.
record_update_failure() {
  now="$(app_version "$APPS_DIR/$APP_NAME")"
  why="${UPDATE_FAILED:-the update stopped part way}"
  if [ "$INTERRUPTED" -eq 1 ]; then why="it was interrupted, as by a shutdown"; fi
  back=""
  if [ "$APP_SWAPPED" -eq 1 ] && [ -n "$now" ] && [ "$now" != "$UPDATING" ]; then
    back=" Put $now back."
    if [ "$AGENT_STOPPED" -eq 1 ] && ! helper_came_back; then
      why="$why; the previous helper could not be started again"
      back=" Put $now back, but it could not be started again."
    fi
  fi
  ST_AT="$(date +%s)"
  if [ "$HOLD" -eq 1 ] && [ "$INTERRUPTED" -ne 1 ]; then
    ST_RETRY=""
    ST_FAILS=0
    write_status failed "$UPDATING" "$why" "$(status_field answer)"
    say "the update to $UPDATING failed: $why.$back It is not tried again until someone asks from Screens."
    return 0
  fi
  ST_FAILS=$((${ST_FAILS:-0} + 1))
  delay=21600
  if [ "$ST_FAILS" -le 4 ]; then delay=$((1800 * (1 << (ST_FAILS - 1)))); fi
  if [ "$delay" -gt 21600 ]; then delay=21600; fi
  ST_RETRY=$((ST_AT + delay))
  write_status retrying "$UPDATING" "$why" "$(status_field answer)"
  say "the update to $UPDATING did not finish: $why.$back Trying again in $((delay / 60)) minutes."
}

# One install or update at a time. A manual install while an update waits for its
# new helper would otherwise have that update's roll back undo the install. A lock
# left by a process that is gone is taken over.
# Two processes can both find the same dead holder. Renaming the lock away is
# atomic, so only one of them gets it; the other's rename finds nothing. A rename
# that instead caught a live process's brand new lock (it took over first, between
# this one's look and its rename) puts that lock back rather than deleting it.
take_over_stale_lock() {
  moved="$UPDATE_LOCK.stale.$$"
  rm -rf "$moved"
  mv "$UPDATE_LOCK" "$moved" 2>/dev/null || return 0
  taken="$(cat "$moved/pid" 2>/dev/null || true)"
  if [ -n "$taken" ] && kill -0 "$taken" 2>/dev/null; then
    if mkdir "$UPDATE_LOCK" 2>/dev/null; then printf '%s\n' "$taken" >"$UPDATE_LOCK/pid"; fi
  fi
  rm -rf "$moved"
}

take_lock() { # seconds to wait for it
  waited=0
  while ! mkdir "$UPDATE_LOCK" 2>/dev/null; do
    holder="$(cat "$UPDATE_LOCK/pid" 2>/dev/null || true)"
    # No pid yet is a lock being taken this moment, unless it stays that way.
    if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } || { [ -z "$holder" ] && [ "$waited" -ge 10 ]; }; then
      take_over_stale_lock
      continue
    fi
    [ "$waited" -lt "$1" ] || return 1
    sleep 2
    waited=$((waited + 2))
  done
  printf '%s\n' "$$" >"$UPDATE_LOCK/pid"
  LOCKED=1
}

release_lock() {
  if [ "$LOCKED" -eq 1 ]; then rm -rf "$UPDATE_LOCK"; fi
  LOCKED=0
}

# An update killed between its two renames (a power cut, SIGKILL) leaves the app
# missing and the previous copy, and any staging folder, under a name with the dead
# pid in it that nothing else would ever sweep. Under the lock, so no live update
# owns them: put the newest previous copy back if the app is gone, then delete the rest.
sweep_leftovers() {
  newest=""
  if [ ! -d "$APPS_DIR/$APP_NAME" ]; then
    # The names are this script's own (a pid), and mtime is what "newest" means.
    # shellcheck disable=SC2012
    newest="$(ls -dt "$APPS_DIR/.$APP_NAME".old.* 2>/dev/null | head -n 1 || true)"
    if [ -n "$newest" ] && [ -d "$newest" ] && [ ! -L "$newest" ] && mv "$newest" "$APPS_DIR/$APP_NAME"; then
      say "an earlier update was cut off and left $APPS_DIR/$APP_NAME missing; put back the previous copy from $newest"
    fi
  fi
  for leftover in "$APPS_DIR/.$APP_NAME".old.* "$APPS_DIR/.$APP_NAME".new.*; do
    [ -e "$leftover" ] || [ -L "$leftover" ] || continue
    rm -rf "$leftover"
    say "removed $leftover, left by an update that did not finish"
  done
}

check_update() {
  find_console_user
  detect_arch
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/stage-utility-update.XXXXXX")"
  # An install by hand, or another check, has the Mac: this one is skipped.
  [ ! -L "$UPDATER_DIR" ] || die "$UPDATER_DIR is a symbolic link; run the installer by hand."
  take_lock 0 || return 0
  sweep_leftovers
  MACHINE="$(tr -d '\r\n' <"$UPDATER_DIR/device-id" 2>/dev/null || true)"
  printf '%s\n' "$MACHINE" | grep -Eq '^[A-Za-z0-9._-]{1,128}$' ||
    die "no usable device id in $UPDATER_DIR/device-id; run the installer by hand."
  HOST_NAME="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
  state="$(status_field state)"
  state="${state:-idle}"
  target="$(status_field target)"
  detail="$(status_field detail)"
  ST_AT="$(status_field at)"
  ST_RETRY="$(status_field retry_after)"
  ST_FAILS="$(status_field fails)"
  ST_FAILS="${ST_FAILS:-0}"
  now="$(date +%s)"
  # An app removed by hand is not this updater's to put back.
  if [ ! -d "$APPS_DIR/$APP_NAME" ]; then
    settle not-installed "$APPS_DIR/$APP_NAME is not there, so there is nothing to update" idle "" ""
    return 0
  fi
  have="$(app_version "$APPS_DIR/$APP_NAME")"
  have="${have:-unknown}"
  # Updated says so for a day; after that the Mac is simply on its version.
  if [ "$state" = updated ] && [ -n "$ST_AT" ] && [ $((now - ST_AT)) -gt 86400 ]; then state=idle; fi
  # After an update, the helper itself says when macOS refuses it the network: it
  # cannot reach the server to say so, so this does.
  if [ "$state" = updated ] || [ "$state" = local-network ]; then
    if [ "$(helper_field localNetworkRefused)" = true ]; then
      [ "$state" = local-network ] || say "macOS refuses the helper Local Network access since the update to $target; someone at the Mac has to choose Allow"
      state=local-network
    elif [ "$state" = local-network ]; then
      say "the helper reaches the network again"
      state=updated
    fi
  fi
  # A wait for a login is only true while nobody is logged in.
  if [ "$state" = no-session ] && [ -n "$CONSOLE_USER" ]; then state=idle; fi

  origin="$(update_server)"
  if [ -z "$origin" ] || ! ask_server "$origin" "$have" "$state" "$target" "$detail"; then
    settle unreachable "no server answered the update check (${origin:-none is recorded in $UPDATER_ORIGIN; run the installer by hand}); trying again in five minutes" "$state" "$target" "$detail"
    return 0
  fi
  want="$(json_field "$WORK/answer" version)"
  go="$(json_field "$WORK/answer" update)"
  reason="$(json_field "$WORK/answer" reason)"
  settle "$reason" "$origin: $reason" "$state" "$target" "$detail"
  [ "$go" = true ] || return 0
  [ -n "$want" ] || die "$origin said to update but named no version."
  # A download that did not finish waits out its back-off, for the same version.
  if [ "$state" = retrying ] && [ "$target" = "$want" ] && [ -n "$ST_RETRY" ] && [ "$now" -lt "$ST_RETRY" ]; then return 0; fi
  if [ "$target" != "$want" ]; then ST_FAILS=0; fi

  # A new helper that nobody's session can start cannot be checked, and could not
  # be put back if it failed, so the update waits for someone to log in.
  if [ -z "$CONSOLE_USER" ]; then
    [ "$state" = no-session ] || say "an update to $want is due, but nobody is logged in to start and check it; waiting for a login"
    write_status no-session "$want" "" "$reason"
    return 0
  fi
  # Quit from its window on purpose (to free a card for another app, say): an update
  # must not start it again behind somebody's back. It updates when it runs again.
  if [ -z "$(helper_pid)" ]; then
    [ "$state" = not-running ] || say "an update to $want is due, but the helper is not running (it was quit at the Mac); it updates once it runs again"
    write_status not-running "$want" "" "$reason"
    return 0
  fi

  say "updating the helper from $have to $want, from $origin"
  UPDATING="$want"
  # What starts the new helper. Without it a swapped app would wait for a login
  # that may be days off, unchecked.
  HOLD=1
  [ -f "$HELPER_PLIST" ] || die "$HELPER_PLIST is missing, so the new helper could not be started; run the installer by hand"
  # A failed download is the network's, and is tried again later; everything after
  # it is this version's.
  HOLD=0
  DOWNLOAD_FROM="$origin"
  fetch_helper
  HOLD=1
  stage_app
  got="$(app_version "$STAGING/$APP_NAME")"
  [ "$got" = "$want" ] || die "the server sent version ${got:-unknown}, not $want"
  stop_helper_agent
  swap_app
  # The previous helper's file must not read as the new one's.
  file="$(helper_status_file || true)"
  if [ -n "$file" ] && [ ! -L "$file" ]; then rm -f "$file"; fi
  if start_helper_agent; then AGENT_STARTED=1; else die "launchd would not start the new helper"; fi
  wait_for_helper "$want" || die "$WHY"
  FINISHED=1
  UPDATING=""
  ST_AT="$(date +%s)"
  ST_RETRY=""
  ST_FAILS=0
  write_status updated "$want" "" "$reason"
  say "updated the helper from $have to $want; it is running"
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
    would "refuse a zip whose SHA-256 differs from the release's"
    would "unpack beside $APPS_DIR/$APP_NAME, check it is $HELPER_LABEL, then swap it in, keeping the old copy until that worked"
    would "write $HELPER_PLIST, root-owned, which starts the helper at every login"
    would "copy this installer to $UPDATER_SCRIPT and write $UPDATER_PLIST, a LaunchDaemon that runs it with --check-update every five minutes: the helper then follows $origin's version, never during a service"
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
  # Not while an automatic update has the Mac: its roll back would undo this.
  [ ! -L "$UPDATER_DIR" ] || die "$UPDATER_DIR is a symbolic link, which this installer will not write through as root. Remove it and run the installer again."
  mkdir -p "$UPDATER_DIR" || die "could not create $UPDATER_DIR."
  if ! take_lock 0; then
    say "    an automatic update is running; waiting for it to finish"
    take_lock 180 || die "an automatic update has held this Mac for three minutes; run the installer again in a few minutes."
  fi
  fetch_helper
  stage_app
  # Apart from the device id and token write_state kept or made (a failed install
  # must not cost a Mac its id, so those stay), everything above has changed
  # nothing on this Mac. The marker is the first other change, and it comes before
  # the helper can possibly launch; see the note on moving off the Chrome kiosk above.
  write_kiosk_marker
  stop_helper_agent
  swap_app
  say "    installed $APPS_DIR/$APP_NAME"
  install_helper_agent
  retire_kiosk
  # Done: nothing after this is undone by a failure. set_power and the updater
  # only warn.
  FINISHED=1
  install_updater
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

# More than one server can answer in the two seconds. The answer kept is the one
# from the server this screen remembers, else one from a server that says it is
# set up there, else the last.
pick() {
  bound="\$(cat "\$BOUND_FILE" 2>/dev/null || true)"
  replies="\$(printf '%s' "\$1" | awk '{ gsub(/\\}\\{"stageUtility"/, "}\\n{\\"stageUtility\\""); print }')"
  mine=""
  [ -n "\$bound" ] && mine="\$(printf '%s\\n' "\$replies" | grep -F "\\"serverId\\":\\"\$bound\\"" | head -n 1)"
  claimed="\$(printf '%s\\n' "\$replies" | grep '"claimed":true' | head -n 1)"
  if [ -n "\$mine" ]; then printf '%s' "\$mine"
  elif [ -n "\$claimed" ]; then printf '%s' "\$claimed"
  else printf '%s\\n' "\$replies" | tail -n 1
  fi
}

# What this screen remembers, and puts in every probe as boundTo: a server that says
# it is set up there, forgotten when that same server says it no longer is. Every
# other server ignores a screen that names somebody else, so remembering one that
# merely answered would keep a released screen away from them for good. An
# answer that does not say either way, from a server older than the field, is
# remembered. Returns 1 when it has just forgotten its server.
remember() {
  srv="\$(printf '%s' "\$1" | sed -n 's/.*"serverId":"\\([^"]*\\)".*/\\1/p')"
  [ -n "\$srv" ] || return 0
  claimed="\$(printf '%s' "\$1" | sed -nE 's/.*"claimed":(true|false).*/\\1/p')"
  if [ "\$claimed" != "false" ]; then
    printf '%s' "\$srv" > "\$BOUND_FILE"
  elif [ "\$srv" = "\$(cat "\$BOUND_FILE" 2>/dev/null)" ] && rm -f "\$BOUND_FILE"; then
    echo "[kiosk] server \$srv no longer has this screen set up; forgot it, so any server can set it up" >&2
    return 1
  fi
}

# One probe: the answer kept, remembered, and the address it gives. An answer that
# makes this screen forget its server is followed straight away by one more probe
# without it, so a server with its Screens page open can answer in this boot
# rather than the next. If none does, the address the old server gave stands.
find_server() {
  reply="\$(pick "\$(discover)")"
  url="\$(printf '%s' "\$reply" | sed -n 's/.*"url":"\\([^"]*\\)".*/\\1/p')"
  if ! remember "\$reply"; then
    again="\$(find_server)"
    [ -n "\$again" ] && url="\$again"
  fi
  printf '%s' "\$url"
}

if [ -r "\$STATE_DIR/server" ]; then
  URL="\$(cat "\$STATE_DIR/server")"
else
  URL=""; fails=0
  while [ -z "\$URL" ]; do
    URL="\$(find_server)"
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
    echo "    both would show on its display. To remove the helper, as root:"
    echo "      launchctl bootout gui/<uid>/$HELPER_LABEL"
    echo "      rm -f \"$HELPER_PLIST\""
    echo "      rm -rf \"$APPS_DIR/$APP_NAME\""
    echo "    The plist is what starts it at every login, so the helper comes back without it."
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
      --check-update) MODE=check ;;
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
  trap 'INTERRUPTED=1; exit 1' HUP INT TERM
  trap on_exit EXIT
  check_macos
  if [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
    die "run with sudo — the device id lives outside your home directory so a profile reset cannot cost you a claim."
  fi

  if [ "$MODE" = check ]; then
    check_update
    FINISHED=1
  elif [ "$MODE" = browser ]; then
    install_browser
  else
    install_helper
  fi
}

# The tests source this file to drive the functions above.
if [ -z "${STAGE_INSTALL_SOURCED:-}" ]; then
  main "$@"
fi
