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

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

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
if command -v sha256sum >/dev/null; then SHACHECK="sha256sum -c -"
elif command -v shasum   >/dev/null; then SHACHECK="shasum -a 256 -c -"
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
    TAG=$(api "releases?per_page=20" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  else
    TAG=$(api "releases/latest" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  fi
fi
[ -n "${TAG:-}" ] || die "Could not determine a release to install. Is the repository reachable?"
VERSION="${TAG#v}"
ARCHIVE="stage-utility-${VERSION}-${PLATFORM}.tar.gz"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

say "Installing ${TAG} for ${PLATFORM}"

# ── Download and verify ───────────────────────────────────────────────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL --retry 3 -o "$WORK/$ARCHIVE" "$BASE/$ARCHIVE" \
  || die "No build for ${PLATFORM} in ${TAG}."
curl -fsSL --retry 3 -o "$WORK/SHA256SUMS" "$BASE/SHA256SUMS" \
  || die "Release ${TAG} publishes no checksums; refusing to install unverified."

say "Verifying"
( cd "$WORK" && grep " ${ARCHIVE}\$" SHA256SUMS | $SHACHECK >/dev/null ) \
  || die "Checksum mismatch — the download does not match the published release. Nothing installed."

# ── Unpack beside the current release, then switch ────────────────────────────
# A versioned directory plus a pointer means the running install is untouched
# until the new one is complete, and the previous release stays on disk.
RELEASE_DIR="${PREFIX}/releases/${VERSION}"
say "Unpacking to ${RELEASE_DIR}"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
tar -xzf "$WORK/$ARCHIVE" -C "$RELEASE_DIR"
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

ln -sfn "$RELEASE_DIR" "${PREFIX}/current"

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
  systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
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
