#!/usr/bin/env bash
#
# uninstall.sh — Remove Stage Utility from this machine.
#
#     sudo ./scripts/uninstall.sh              # find and remove what is here
#     sudo ./scripts/uninstall.sh --dry-run    # say what it would do, change nothing
#     ./scripts/uninstall.sh --brew            # Homebrew only (do NOT use sudo)
#
# Covers every way the app registers itself:
#
#   linux    systemd unit + /opt/stage-utility + the stage-utility account
#   macOS    launchd daemon + /usr/local/stage-utility
#   macOS    the Mac output helper (or the Chrome kiosk) that kiosk/install-macos.sh
#            installs: its LaunchAgent, its app, the kiosk launcher
#   brew     the formula and its launchd agent (run WITHOUT sudo)
#
# Detected, never assumed: each removal runs only if that thing is actually
# present, so this is safe on a machine with one method, several, or none.
#
# THE DATA DIRECTORY IS NEVER REMOVED. It holds the operator's configuration,
# history, and the encryption key that makes stored secrets readable — deleting
# an operator's data to tidy up is not this script's call. Its path is printed
# so it can be backed up or removed deliberately. The same goes for a Mac's device
# id and token, and each account's output settings: listed, with the command that
# removes them, never removed.
#
# The sleep and screen saver settings the Mac installer changed are NOT put back:
# it does not record what they were, so the script prints what to set instead of
# guessing.
#
# Why the service registration goes first: one left behind keeps starting a
# server that fights the new one for port 8788 — including after switching
# install methods, where it presents as the NEW method being broken.
#
set -euo pipefail

SERVICE_NAME="stage-utility"
# Prefix for every system path below. Empty on a real machine; a test points it at
# a scratch directory so the real script runs, as --dry-run, without touching one.
ROOT="${STAGE_UNINSTALL_TEST_ROOT:-}"
UNIT_PATH="${ROOT}/etc/systemd/system/${SERVICE_NAME}.service"
LAUNCHD_DIR="${ROOT}/Library/LaunchDaemons"
# Current label first, then the one installers registered before the rename. An
# install from either era is removed, and a box part-way through a migration has
# both.
LAUNCHD_LABELS=("com.stageutility.server" "com.cornerstone.${SERVICE_NAME}")
LINUX_PREFIX="${STAGE_PREFIX:-${ROOT}/opt/stage-utility}"
MACOS_PREFIX="${STAGE_PREFIX:-${ROOT}/usr/local/stage-utility}"
# What kiosk/install-macos.sh installs on a Mac that shows screens: the same names
# in the same places. A test reads both scripts and fails if they drift apart.
AGENT_DIR="${ROOT}/Library/LaunchAgents"
APPS_DIR="${ROOT}/Applications"
STATE_DIR="${ROOT}/Library/Application Support/StageUtility"
USERS_DIR="${ROOT}/Users"
HELPER_LABEL="com.stageutility.output"
HELPER_APP="StageUtilityOutput.app"
HELPER_EXEC="StageUtilityOutput"
KIOSK_LABEL="com.stageutility.kiosk"
KIOSK_BIN="${ROOT}/usr/local/bin/stage-utility-kiosk"
FORMULAE=("stage-utility" "stage-utility-beta")

DRY_RUN=""
BREW_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --brew) BREW_ONLY=1 ;;
    -h|--help) sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m[uninstall]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[uninstall]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[uninstall]\033[0m %s\n' "$*" >&2; exit 1; }
# Every mutation goes through this, so --dry-run cannot miss one.
run()  {
  if [ -n "$DRY_RUN" ]; then printf '  would run: %s\n' "$*"; else "$@"; fi
}

# Root is needed to REMOVE, never to look. A preview that refuses without sudo
# is a preview nobody can use before deciding to run the real thing.
need_root() {
  [ "$(id -u)" -eq 0 ] && return 0
  [ -n "$DRY_RUN" ] && { warn "$1 needs root — showing what it would do anyway"; return 0; }
  die "$1 needs root. Re-run with sudo."
}

# Remove a file or folder if it is there, saying what it belongs to. $1 is that,
# $2 the path, and the rest are rm's flags (-f for a file, -rf for a folder).
remove_path() {
  local what="$1" target="$2"
  shift 2
  [ -e "$target" ] || return 0
  log "${what}: removing ${target}"
  run rm "$@" "$target"
}

# True when $1 is one of the remaining arguments.
contains() {
  local needle="$1" item
  shift
  for item in "$@"; do
    if [ "$item" = "$needle" ]; then return 0; fi
  done
  return 1
}

FOUND=0
DATA_DIRS=()
note_data() {
  [ -n "${1:-}" ] || return 0
  contains "$1" ${DATA_DIRS[@]+"${DATA_DIRS[@]}"} || DATA_DIRS+=("$1")
}

# Data of the Mac output helper and the Chrome kiosk, listed at the end like the
# server's data directory: it is the operator's, so it is never removed here.
HELPER_DATA=()
note_helper_data() {
  contains "$1" ${HELPER_DATA[@]+"${HELPER_DATA[@]}"} || HELPER_DATA+=("$1")
}
# Set when a Mac installer's agent is removed: its power settings stay changed.
POWER_CHANGED=""

# ── Homebrew ──────────────────────────────────────────────────────────────────
# Deliberately NOT under sudo: brew refuses to run as root, and the agent is
# registered in the user's own gui/<uid> domain, where root cannot reach it.
remove_brew() {
  [ "$(id -u)" -eq 0 ] && { warn "skipping Homebrew: re-run WITHOUT sudo to remove a brew install"; return 0; }

  for formula in "${FORMULAE[@]}"; do
    local label="homebrew.mxcl.${formula}"
    local agent="${HOME}/Library/LaunchAgents/${label}.plist"

    if command -v brew >/dev/null 2>&1 && brew list --versions "$formula" >/dev/null 2>&1; then
      FOUND=1
      log "Homebrew: removing ${formula}"
      note_data "$(brew --prefix)/var/stage-utility"
      run brew services stop "$formula" || warn "could not stop ${formula} (continuing)"
      run brew uninstall "$formula" || warn "could not uninstall ${formula}"
    fi

    # Orphan cleanup, INDEPENDENT of whether the formula is installed.
    #
    # `brew uninstall` does not stop or unregister the service, so a keg can be
    # deleted while its agent keeps running — the process serves from files that
    # no longer exist (version 0.0.0, no settings page) and holds port 8788
    # against whatever you install next. Seen on a real machine: a Homebrew
    # install removed to test the one-line installer left a zombie that made the
    # NEW install look broken. The stale label is also what makes every future
    # `brew services start` fail with "Bootstrap failed: 5", permanently.
    if [ "$(uname -s)" = "Darwin" ] && launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
      FOUND=1
      log "Homebrew: clearing a leftover ${label} registration"
      run launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
    fi
    if [ -f "$agent" ]; then
      FOUND=1
      log "Homebrew: removing ${agent}"
      run rm -f "$agent"
    fi
  done
}

# Shared by both packaged paths: the versioned release tree the installer wrote.
remove_tree() {
  local prefix="$1"
  [ -d "$prefix" ] || return 0
  log "removing the install at ${prefix}"
  run rm -rf "$prefix"
}

# ── Linux: systemd ────────────────────────────────────────────────────────────
remove_systemd() {
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}.service" || [ -f "$UNIT_PATH" ] || return 0
  FOUND=1
  need_root "Removing the systemd service"

  # Read the data dir out of the unit before deleting it — afterwards there is
  # nothing left that knows where it was.
  [ -f "$UNIT_PATH" ] && note_data "$(sed -n 's/^Environment=STAGE_UTILITY_DATA=//p' "$UNIT_PATH" | head -n1)"

  log "systemd: stopping and disabling ${SERVICE_NAME}"
  run systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  if [ -f "$UNIT_PATH" ]; then
    log "systemd: removing ${UNIT_PATH}"
    run rm -f "$UNIT_PATH"
    run systemctl daemon-reload
  fi
  remove_tree "$LINUX_PREFIX"
  # Only when nothing else on the box uses it, and never fatal.
  if id -u "$SERVICE_NAME" >/dev/null 2>&1; then
    log "systemd: removing the ${SERVICE_NAME} account"
    run userdel "$SERVICE_NAME" 2>/dev/null || warn "could not remove the ${SERVICE_NAME} account (in use?)"
  fi
}

# ── macOS: launchd daemon ─────────────────────────────────────────────────────
remove_launchd() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  local label plist loaded removed=""
  for label in "${LAUNCHD_LABELS[@]}"; do
    plist="${LAUNCHD_DIR}/${label}.plist"
    # Loaded OR on disk: a plist deleted by hand leaves the job running, and a
    # job booted out leaves its plist to start again at boot.
    loaded=""
    if launchctl print "system/${label}" >/dev/null 2>&1; then loaded=1; fi
    [ -f "$plist" ] || [ -n "$loaded" ] || continue
    FOUND=1
    removed=1
    need_root "Removing the launchd daemon"

    if [ -f "$plist" ]; then
      note_data "$(sed -n 's:.*<key>STAGE_UTILITY_DATA</key><string>\(.*\)</string>.*:\1:p' "$plist" | head -n1)"
    fi
    # bootout first, and it matters on its own: deleting the plist stops it
    # returning at boot but leaves the running process serving until a restart.
    log "launchd: stopping ${label}"
    run launchctl bootout "system/${label}" 2>/dev/null || true
    remove_path "launchd" "$plist" -f
  done
  [ -n "$removed" ] || return 0
  remove_tree "$MACOS_PREFIX"
}

# ── macOS: the output helper and the Chrome kiosk ─────────────────────────────
# Both are LaunchAgents: root-owned plists in /Library/LaunchAgents that launchd
# loads into each account's gui/<uid> domain at login. Root can boot one out of
# that domain (the installer does), so this runs under sudo like the daemon above.

GUI_UIDS=()
add_gui_uid() {
  local uid
  [ -n "$1" ] && [ "$1" != root ] || return 0
  # A name that is not an account (Shared) has no uid and is skipped.
  uid="$(id -u "$1" 2>/dev/null)" || return 0
  contains "$uid" ${GUI_UIDS[@]+"${GUI_UIDS[@]}"} || GUI_UIDS+=("$uid")
}

# Every account that may have the agents loaded: the console user, found as the
# installer finds it, and each account with a home folder. More than one can be
# logged in at once, and the plist loads for all of them.
find_gui_uids() {
  local console="" home
  GUI_UIDS=()
  if [ -n "${STAGE_UNINSTALL_TEST_CONSOLE_USER:-}" ]; then
    console="$STAGE_UNINSTALL_TEST_CONSOLE_USER"
    if [ "$console" = none ]; then console=""; fi
  else
    console="$(stat -f %Su /dev/console 2>/dev/null || true)"
  fi
  add_gui_uid "$console"
  for home in "$USERS_DIR"/*/; do
    if [ -d "$home" ]; then add_gui_uid "$(basename "$home")"; fi
  done
}

# Whether the agent is loaded in any account's session.
agent_loaded() {
  local uid
  for uid in ${GUI_UIDS[@]+"${GUI_UIDS[@]}"}; do
    if launchctl print "gui/${uid}/$1" >/dev/null 2>&1; then return 0; fi
  done
  return 1
}

# Boot an agent out of every session it is loaded in. Through launchctl, never by
# killing the process: launchd would start a killed one again, and the app is not
# cut off mid-write.
boot_out_agent() {
  local uid
  for uid in ${GUI_UIDS[@]+"${GUI_UIDS[@]}"}; do
    launchctl print "gui/${uid}/$1" >/dev/null 2>&1 || continue
    log "launchd: stopping ${1} for uid ${uid}"
    run launchctl bootout "gui/${uid}/$1" || warn "could not stop ${1} for uid ${uid}"
  done
}

# What kiosk/install-macos.sh leaves that is the operator's: the Mac's device id
# and token (removing them makes the next install a new device, whose screens are
# claimed again) and each account's output settings.
note_mac_state() {
  local home
  if [ -d "$STATE_DIR" ]; then note_helper_data "$STATE_DIR"; fi
  for home in "$USERS_DIR"/*/; do
    if [ -d "${home}Library/Application Support/StageUtilityOutput" ]; then
      note_helper_data "${home}Library/Application Support/StageUtilityOutput"
    fi
  done
}

remove_output_helper() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  local plist="${AGENT_DIR}/${HELPER_LABEL}.plist" app="${APPS_DIR}/${HELPER_APP}" uid
  find_gui_uids
  [ -f "$plist" ] || [ -d "$app" ] || agent_loaded "$HELPER_LABEL" || return 0
  FOUND=1
  POWER_CHANGED=1
  need_root "Removing the Mac output helper"

  # Stopped first: removing the plist only keeps it from returning at the next login.
  boot_out_agent "$HELPER_LABEL"
  remove_path "output helper" "$plist" -f
  remove_path "output helper" "$app" -rf
  # A copy opened by hand is not launchd's and stays up until it is quit. It is
  # not killed from here: it is the operator's window, and may be mid-save.
  if [ -z "$DRY_RUN" ]; then
    for uid in ${GUI_UIDS[@]+"${GUI_UIDS[@]}"}; do
      if pgrep -x -u "$uid" "$HELPER_EXEC" >/dev/null 2>&1; then
        warn "the helper is still running for uid ${uid}, outside launchd: quit it from its menu bar icon"
      fi
    done
  fi
  note_mac_state
}

remove_chrome_kiosk() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  local plist="${AGENT_DIR}/${KIOSK_LABEL}.plist"
  find_gui_uids
  [ -f "$plist" ] || [ -e "$KIOSK_BIN" ] || agent_loaded "$KIOSK_LABEL" || return 0
  FOUND=1
  POWER_CHANGED=1
  need_root "Removing the Chrome kiosk"

  boot_out_agent "$KIOSK_LABEL"
  remove_path "Chrome kiosk" "$plist" -f
  remove_path "Chrome kiosk" "$KIOSK_BIN" -f
  # Its Chrome profile and the server address it found are in the state directory.
  note_mac_state
}

if [ -n "$BREW_ONLY" ]; then
  remove_brew
else
  remove_brew
  remove_systemd
  remove_launchd
  remove_output_helper
  remove_chrome_kiosk
fi

if [ "$FOUND" -eq 0 ]; then
  log "Nothing to remove — no systemd unit, launchd daemon, Mac output helper, Chrome kiosk, or Homebrew install found."
  [ "$(uname -s)" = "Darwin" ] && [ "$(id -u)" -eq 0 ] && \
    warn "Homebrew installs are skipped under sudo — re-run without it if you have one."
  exit 0
fi

log "Done."
if [ ${#DATA_DIRS[@]} -gt 0 ]; then
  log "Data left intact (config, history, encryption key) — remove deliberately if you no longer need it:"
  for d in "${DATA_DIRS[@]}"; do printf '    %s\n' "$d"; done
fi
if [ ${#HELPER_DATA[@]} -gt 0 ]; then
  log "A Mac's device id and token, and each account's output settings, are left intact."
  log "Without the device id a reinstall is a new device and its screens are claimed again; outputs.json holds secret tokens. Remove deliberately with sudo rm -rf on:"
  for d in "${HELPER_DATA[@]}"; do printf '    %s\n' "$d"; done
fi
if [ -n "$POWER_CHANGED" ]; then
  log "Not put back: the installer turned off display sleep, system sleep, and the screen saver's"
  log "idle time and password, and did not record what they were. Set them to what you want:"
  printf '    %s\n' \
    "sudo pmset -a displaysleep <minutes> sleep <minutes>      (pmset -g custom shows what is set now)" \
    "defaults -currentHost write com.apple.screensaver idleTime <seconds>      (as each account; 0 is never)" \
    "defaults write com.apple.screensaver askForPassword -int <1 to ask, 0 not to>      (as each account)" \
    "or System Settings > Lock Screen"
fi
