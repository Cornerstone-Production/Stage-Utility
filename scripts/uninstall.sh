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
#   brew     the formula and its launchd agent (run WITHOUT sudo)
#
# Detected, never assumed: each removal runs only if that thing is actually
# present, so this is safe on a machine with one method, several, or none.
#
# THE DATA DIRECTORY IS NEVER REMOVED. It holds the operator's configuration,
# history, and the encryption key that makes stored secrets readable — deleting
# an operator's data to tidy up is not this script's call. Its path is printed
# so it can be backed up or removed deliberately.
#
# Why the service registration goes first: one left behind keeps starting a
# server that fights the new one for port 8788 — including after switching
# install methods, where it presents as the NEW method being broken.
#
set -euo pipefail

SERVICE_NAME="stage-utility"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
PLIST_PATH="/Library/LaunchDaemons/com.cornerstone.${SERVICE_NAME}.plist"
LINUX_PREFIX="${STAGE_PREFIX:-/opt/stage-utility}"
MACOS_PREFIX="${STAGE_PREFIX:-/usr/local/stage-utility}"
FORMULAE=("stage-utility" "stage-utility-beta")

DRY_RUN=""
BREW_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --brew) BREW_ONLY=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

FOUND=0
DATA_DIRS=()
note_data() { [ -n "${1:-}" ] && DATA_DIRS+=("$1"); }

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
  [ -f "$PLIST_PATH" ] || return 0
  FOUND=1
  need_root "Removing the launchd daemon"

  note_data "$(sed -n 's:.*<key>STAGE_UTILITY_DATA</key><string>\(.*\)</string>.*:\1:p' "$PLIST_PATH" | head -n1)"
  # bootout first, and it matters on its own: deleting the plist stops it
  # returning at boot but leaves the running process serving until a restart.
  log "launchd: stopping com.cornerstone.${SERVICE_NAME}"
  run launchctl bootout "system/com.cornerstone.${SERVICE_NAME}" 2>/dev/null || true
  log "launchd: removing ${PLIST_PATH}"
  run rm -f "$PLIST_PATH"
  remove_tree "$MACOS_PREFIX"
}


if [ -n "$BREW_ONLY" ]; then
  remove_brew
else
  remove_brew
  remove_systemd
  remove_launchd
fi

if [ "$FOUND" -eq 0 ]; then
  log "Nothing to remove — no systemd unit, launchd daemon, or Homebrew install found."
  [ "$(uname -s)" = "Darwin" ] && [ "$(id -u)" -eq 0 ] && \
    warn "Homebrew installs are skipped under sudo — re-run without it if you have one."
  exit 0
fi

log "Done."
if [ ${#DATA_DIRS[@]} -gt 0 ]; then
  log "Data left intact (config, history, encryption key) — remove deliberately if you no longer need it:"
  for d in "${DATA_DIRS[@]}"; do printf '    %s\n' "$d"; done
fi
