#!/usr/bin/env bash
#
# Stage Utility installer — Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.sh | sudo bash
#
# Downloads the release archive for this machine, verifies it against the
# published checksums, and registers an auto-starting service. Nothing is built
# here and no toolchain is needed: the archive carries its own Node runtime.
#
# Options (environment):
#   STAGE_TRACK=main|beta   which release line to follow      (default: main)
#   STAGE_VERSION=v1.9.2    pin an exact release              (default: newest)
#   STAGE_PREFIX=/opt/…     where to install
#   STAGE_DATA=/var/lib/…   where config and history live
#   STAGE_PORT=8788         the port to serve on
#   STAGE_NO_SERVICE=1      install the files, register nothing
#
set -euo pipefail

REPO="${STAGE_REPO:-Cornerstone-Production/Stage-Utility}"
TRACK="${STAGE_TRACK:-main}"
PORT="${STAGE_PORT:-8788}"
SERVICE_NAME="stage-utility"

# Colour only for a human at a terminal. When the app drives this the output is
# redirected to log files, where escape codes are noise that also break grep.
if [ -t 1 ]; then C_INFO=$'\033[1;36m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else C_INFO=""; C_WARN=""; C_ERR=""; C_OFF=""; fi

say()  { printf '%s==>%s %s\n' "$C_INFO" "$C_OFF" "$*"; }
warn() { printf '%s warn%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; write_result false "$*"; exit 1; }

# ── Update protocol (optional) ────────────────────────────────────────────────
# When the app drives this script it passes these paths and reads them back to
# narrate the update; a human running the installer by hand passes neither and
# both helpers become no-ops. The format matches scripts/update.sh exactly,
# because the app's poller already knows how to read it — which is why driving
# the installer from the app needs no UI change at all.
_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
write_progress() {
  [ -n "${STAGE_UPDATE_PROGRESS:-}" ] || return 0
  printf '{"step":"%s","at":"%s"}' "$1" "$(_now)" >"$STAGE_UPDATE_PROGRESS" 2>/dev/null || true
}
# Error text goes into a JSON string, and these messages are multi-line and
# contain quotes. Left raw they produce a file JSON.parse rejects - and the
# result file is precisely what tells the UI an update is over, so an
# unparseable one puts it back to waiting forever on a run that has already
# failed. Backslash and quote are escaped; every control character (newlines
# included) collapses to a space.
_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '
}
write_result() {
  [ -n "${STAGE_UPDATE_RESULT:-}" ] || return 0
  printf '{"ok":%s,"error":"%s","at":"%s"}' "$1" "$(_json_escape "${2:-}")" "$(_now)" \
    >"$STAGE_UPDATE_RESULT" 2>/dev/null || true
}
# Any unexpected failure reports too, so the UI can never wait forever on a run
# that has already died.
trap 'write_result false "installer failed - see the server log"' ERR

# ── Where this script's output goes ───────────────────────────────────────────
# The app spawns the installer detached with stdio ignored, so ANYTHING printed
# here is thrown away unless it is written to a file. That is the difference
# between "the update failed" and knowing which step failed and why.
#
# STAGE_UPDATE_LIVE_LOG is tailed into /log while the update runs; STAGE_UPDATE_LOG
# is the persistent record that survives the restart. Everything - including curl
# and tar errors on stderr - goes to both, and still to the console for a human
# running this by hand.
_logs=""
[ -n "${STAGE_UPDATE_LIVE_LOG:-}" ] && _logs="$_logs $STAGE_UPDATE_LIVE_LOG"
[ -n "${STAGE_UPDATE_LOG:-}" ] && _logs="$_logs $STAGE_UPDATE_LOG"
if [ -n "$_logs" ]; then
  # shellcheck disable=SC2086
  exec > >(tee -a $_logs) 2>&1
fi

# Timestamped so a slow step is visible as a gap rather than having to be guessed.
log() { printf '[install %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

# ── Where things go ───────────────────────────────────────────────────────────
case "$(uname -s)" in
  Linux)  OS=linux;  PREFIX="${STAGE_PREFIX:-/opt/stage-utility}";       DATA="${STAGE_DATA:-/var/lib/stage-utility}" ;;
  Darwin) OS=darwin; PREFIX="${STAGE_PREFIX:-/usr/local/stage-utility}"; DATA="${STAGE_DATA:-/usr/local/var/stage-utility}" ;;
  *) die "Unsupported system: $(uname -s). Windows users: see install.ps1." ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l|armv6l) die "32-bit ARM is not published. A 64-bit Raspberry Pi OS runs the arm64 build." ;;
  *) die "Unsupported architecture: $(uname -m)." ;;
esac
PLATFORM="${OS}-${ARCH}"

# ── Preconditions, checked before anything is written ─────────────────────────
[ "$(id -u)" -eq 0 ] || die "Run with sudo — this installs a system service.

  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sudo bash"

for tool in curl tar; do
  command -v "$tool" >/dev/null || die "'$tool' is required but not installed."
done

# One of these must exist to verify the download. Refusing to continue without
# one is deliberate: an unverified archive is the thing this script must not
# install.
if command -v sha256sum >/dev/null; then SHASUM="sha256sum"
elif command -v shasum   >/dev/null; then SHASUM="shasum -a 256"
else die "Neither sha256sum nor shasum is available; cannot verify the download."
fi

# ── Which release ─────────────────────────────────────────────────────────────
api() { curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${REPO}/$1"; }

if [ -n "${STAGE_VERSION:-}" ]; then
  TAG="${STAGE_VERSION#v}"; TAG="v${TAG}"
else
  say "Finding the newest ${TRACK} release"
  # `beta` takes prereleases and releases both; `main` takes only full releases.
  if [ "$TRACK" = beta ]; then
    RELEASE_JSON=$(api "releases?per_page=20")
  else
    RELEASE_JSON=$(api "releases/latest")
  fi
  TAG=$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
fi
[ -n "${TAG:-}" ] || die "Could not determine a release to install. Is the repository reachable?"
VERSION="${TAG#v}"
ARCHIVE="stage-utility-${VERSION}-${PLATFORM}.tar.gz"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

log "mode=${STAGE_UPDATE_MODE:-install} track=${TRACK} tag=${TAG} platform=${PLATFORM}"
log "prefix=${PREFIX} data=${DATA} port=${PORT} user=$(id -un) pid=$$"
log "archive=${ARCHIVE}"
log "url=${BASE}/${ARCHIVE}"
say "Installing ${TAG} for ${PLATFORM}"
write_progress pull

# ── Download and verify ───────────────────────────────────────────────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log "downloading to $WORK/$ARCHIVE"
curl -fsSL --retry 3 -o "$WORK/$ARCHIVE" "$BASE/$ARCHIVE" \
  || die "No build for ${PLATFORM} in ${TAG}. Check that the release publishes ${ARCHIVE}."
log "downloaded $(wc -c < "$WORK/$ARCHIVE" | tr -d " ") bytes"

# The expected hash comes from the releases API, not from anything inside the
# archive — a checksum shipped inside the file it describes proves nothing,
# because whoever alters the file alters the checksum with it.
#
# Pinned to a specific release when STAGE_VERSION was given, since the payload
# fetched above is then the wrong one (or absent).
if [ -z "${RELEASE_JSON:-}" ]; then
  RELEASE_JSON=$(api "releases/tags/${TAG}") \
    || die "Could not read release ${TAG} to verify the download."
fi

write_progress install
say "Verifying"
# Within an asset object the API emits "name" before "digest", so the digest we
# want is the first one after this archive's name. Anchoring on the exact name
# is what stops another platform's hash being read as this one's — and the
# response is pretty-printed, so the two fields are never on the same line.
WANT=$(printf '%s' "$RELEASE_JSON" | awk -v want="\"name\": \"${ARCHIVE}\"" '
  index($0, want) { found = 1; next }
  found && /"digest": "sha256:/ {
    if (match($0, /[0-9a-f]{64}/)) { print substr($0, RSTART, RLENGTH); exit }
  }
')

[ -n "${WANT:-}" ] \
  || die "Release ${TAG} publishes no checksum for ${ARCHIVE}; refusing to install unverified."

GOT=$(cd "$WORK" && $SHASUM "$ARCHIVE" | cut -d" " -f1)
log "checksum expected=${WANT}"
log "checksum actual  =${GOT}"
[ "$WANT" = "$GOT" ] \
  || die "Checksum mismatch — the download does not match the published release. Nothing installed."
log "checksum verified"

# ── Unpack beside the current release, then switch ────────────────────────────
# A versioned directory plus a pointer means the running install is untouched
# until the new one is complete, and the previous release stays on disk.
RELEASE_DIR="${PREFIX}/releases/${VERSION}"
say "Unpacking to ${RELEASE_DIR}"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
log "unpacking into ${RELEASE_DIR}"
tar -xzf "$WORK/$ARCHIVE" -C "$RELEASE_DIR" || die "Could not unpack ${ARCHIVE} into ${RELEASE_DIR}."
log "unpacked $(ls -1 "$RELEASE_DIR" | wc -l | tr -d " ") entries"
[ -x "${RELEASE_DIR}/node" ] || die "Archive is missing its runtime — refusing to switch to it."

mkdir -p "$DATA"

# ── Service user ──────────────────────────────────────────────────────────────
# A dedicated account owns the data and the install, so an update needs no
# elevation and a compromise of the server is not a compromise of root.
SERVICE_USER="${STAGE_USER:-stage-utility}"
if [ "$OS" = linux ]; then
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    say "Creating the ${SERVICE_USER} account"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
      || useradd -r -s /bin/false "$SERVICE_USER"
  fi
else
  SERVICE_USER="${STAGE_USER:-root}" # launchd daemons run as root unless told otherwise
fi

chown -R "$SERVICE_USER" "$PREFIX" "$DATA" 2>/dev/null || true

# The swap. Flipping a symlink is atomic, and the running server keeps its open
# inodes on the old release, so it carries on serving until it is restarted.
write_progress build
log "pointing ${PREFIX}/current at ${RELEASE_DIR}"
ln -sfn "$RELEASE_DIR" "${PREFIX}/current"
log "swap complete"

# ── Update mode ───────────────────────────────────────────────────────────────
# The service already exists and is RUNNING: every slow step above - download,
# verify, unpack - happened while it kept serving, and the swap above is done.
# So do not stop it and do not re-register it. Ask it to exit; the service
# manager relaunches it on the new files.
#
# The ordering is the point. Stopping the service first would blank every
# display for the length of the download, and on systemd it would tear down the
# cgroup this script runs in, killing the update midway through the swap.
if [ "${STAGE_UPDATE_MODE:-}" = "swap" ]; then
  # auto-install mode: the new release is staged and swapped, but the operator
  # chooses when the displays go dark. Leave the restart-pending marker the app
  # reports (same contract as scripts/update.sh) and stop here — the running
  # server keeps serving the OLD build from its open inodes until restarted.
  if [ -n "${STAGE_UPDATE_DEFER_RESTART:-}" ]; then
    say "Swap complete. Restart deferred (auto-install mode)."
    if [ -n "${STAGE_UPDATE_RESTART_PENDING:-}" ]; then
      date -u +%Y-%m-%dT%H:%M:%SZ > "$STAGE_UPDATE_RESTART_PENDING" 2>/dev/null || true
    fi
    write_result true ""
    log "update staged; restart deferred"
    exit 0
  fi
  say "Swap complete. Restarting the running server."
  write_progress restarting
  write_result true ""
  if [ -n "${STAGE_UPDATE_SERVER_PID:-}" ]; then
    log "signalling server pid ${STAGE_UPDATE_SERVER_PID} to exit for restart"
    sleep 1  # let the HTTP response that triggered this flush first
    kill "$STAGE_UPDATE_SERVER_PID" 2>/dev/null \
      || log "WARNING: could not signal pid ${STAGE_UPDATE_SERVER_PID}; it may have already exited"
  else
    log "WARNING: no STAGE_UPDATE_SERVER_PID given - the new build is in place but nothing was restarted"
  fi
  log "update finished"
  exit 0
fi

if [ -n "${STAGE_NO_SERVICE:-}" ]; then
  say "Files installed. Skipping service registration (STAGE_NO_SERVICE set)."
  echo "  start it with: STAGE_UTILITY_DATA=$DATA ${PREFIX}/current/node ${PREFIX}/current/server.mjs"
  exit 0
fi

# ── Register the service ──────────────────────────────────────────────────────
if [ "$OS" = linux ]; then
  command -v systemctl >/dev/null || die "systemd not found. Re-run with STAGE_NO_SERVICE=1 and start it yourself."
  say "Installing the systemd service"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Stage Utility
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Environment=NODE_ENV=production
Environment=STAGE_UTILITY_DATA=${DATA}
Environment=STAGE_UTILITY_PORT=${PORT}
Environment=STAGE_UTILITY_ROOT=${PREFIX}/current
# Declares how this copy was installed, so the in-app updater picks the right
# strategy instead of inferring one from the path.
Environment=STAGE_UTILITY_INSTALL_KIND=tarball
WorkingDirectory=${PREFIX}/current
ExecStart=${PREFIX}/current/node ${PREFIX}/current/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  # Serving on 80 as well as ${PORT} needs the capability, since the service is
  # not root. Granted to the runtime in this release directory only.
  setcap 'cap_net_bind_service=+ep' "${RELEASE_DIR}/node" 2>/dev/null \
    || warn "Could not grant port-80 binding; the app will still serve on ${PORT}."
  systemctl daemon-reload
  # NOT "|| true". This is the line that decides whether the server comes back
  # after a power cut, and an install that silently skipped it looks identical
  # to one that worked until the day the building loses power.
  systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 \
    || die "Could not enable ${SERVICE_NAME} to start at boot. It would not survive a restart."
  systemctl restart "${SERVICE_NAME}"
else
  say "Installing the launchd daemon"
  cat > "/Library/LaunchDaemons/com.cornerstone.${SERVICE_NAME}.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.cornerstone.${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PREFIX}/current/node</string>
    <string>${PREFIX}/current/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>NODE_ENV</key><string>production</string>
    <key>STAGE_UTILITY_DATA</key><string>${DATA}</string>
    <key>STAGE_UTILITY_PORT</key><string>${PORT}</string>
    <key>STAGE_UTILITY_ROOT</key><string>${PREFIX}/current</string>
    <key>STAGE_UTILITY_INSTALL_KIND</key><string>tarball</string>
  </dict>
  <key>WorkingDirectory</key><string>${PREFIX}/current</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST
  launchctl unload "/Library/LaunchDaemons/com.cornerstone.${SERVICE_NAME}.plist" 2>/dev/null || true
  launchctl load  -w "/Library/LaunchDaemons/com.cornerstone.${SERVICE_NAME}.plist"
fi

# ── Confirm it is actually serving ────────────────────────────────────────────
# ── Will it come back by itself? ──────────────────────────────────────────────
# Registering a service and having it start at boot are different things. This
# checks the second one, because the first is what an installer usually proves.
if [ "$OS" = linux ]; then
  if systemctl is-enabled "${SERVICE_NAME}" >/dev/null 2>&1; then
    log "boot: enabled - will restart after a power loss"
  else
    die "${SERVICE_NAME} is not enabled at boot; it would not survive a restart."
  fi
else
  if launchctl print "system/com.cornerstone.${SERVICE_NAME}" >/dev/null 2>&1; then
    log "boot: loaded as a launchd daemon - will restart after a power loss"
  else
    warn "The launchd daemon does not appear loaded; it may not survive a restart."
  fi
fi

say "Waiting for it to come up"
for _ in $(seq 1 30); do
  sleep 1
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/state" >/dev/null 2>&1; then
    IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -n "${IP:-}" ] || IP=$(ipconfig getifaddr en0 2>/dev/null || echo localhost)
    printf '\n\033[1;32mStage Utility %s is running.\033[0m\n\n' "$TAG"
    printf '  Open   http://%s:%s/\n' "$IP" "$PORT"
    printf '  Data   %s\n' "$DATA"
    printf '  Update from Settings → Advanced → Updates\n\n'
    exit 0
  fi
done

die "Installed, but it did not answer on port ${PORT} within 30s.
  Linux: journalctl -u ${SERVICE_NAME} -n 50
  macOS: log show --predicate 'process == \"node\"' --last 5m"
