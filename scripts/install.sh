#!/usr/bin/env bash
#
# install.sh — One-command installer for Stage Utility on Linux + systemd.
#
# Run from a checked-out copy of the repo:
#     sudo ./scripts/install.sh
#
# Idempotent: re-run after a `git pull` to update an existing install
# (re-installs deps, rebuilds the UI, and restarts the service).
#
# Environment / flag overrides:
#     STAGE_UTILITY_DATA=/path   data directory (default: /var/lib/stage-utility)
#     --data-dir <path>          same as STAGE_UTILITY_DATA
#     --user <name>              run the service as this user (default: $SUDO_USER)
#     --no-service               build only; don't install/enable the systemd unit
#
set -euo pipefail

# ── Constants ───────────────────────────────────────────────────────────────
SERVICE_NAME="stage-utility"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
PORT=8788
FRIENDLY_PORT=80   # bound in addition to PORT so the LAN URL needs no port
MIN_NODE_MAJOR=24

# Repo root = parent of this script's directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Defaults (overridable) ────────────────────────────────────────────────────
DATA_DIR="${STAGE_UTILITY_DATA:-/var/lib/stage-utility}"
SERVICE_USER="${SUDO_USER:-$(id -un)}"
INSTALL_SERVICE=1

# ── Parse flags ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --user)     SERVICE_USER="$2"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Check Node ≥ 24 and npm ────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die \
  "Node.js not found. Install Node >= ${MIN_NODE_MAJOR} (https://github.com/nodesource/distributions) and re-run."
command -v npm >/dev/null 2>&1 || die "npm not found. Install Node.js (which bundles npm) and re-run."

NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${NODE_MAJOR}" -lt "${MIN_NODE_MAJOR}" ]]; then
  die "Node >= ${MIN_NODE_MAJOR} required; found $(node -v). Upgrade Node and re-run."
fi
log "Node $(node -v) at ${NODE_BIN} — OK"

# ── 2. Stop existing server (free the port before rebuilding) ─────────────────
log "Repo: ${REPO_ROOT}"
cd "${REPO_ROOT}"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
  log "Stopping ${SERVICE_NAME} service..."
  systemctl stop "${SERVICE_NAME}"
fi
# Also kill any stray process holding the port (e.g. a manual server start).
STRAY_PID="$(lsof -ti :${PORT} 2>/dev/null || true)"
if [[ -n "${STRAY_PID}" ]]; then
  warn "Killing stray process on port ${PORT} (PID ${STRAY_PID})..."
  kill "${STRAY_PID}" 2>/dev/null || true
  sleep 1
fi

# ── 3. Build ──────────────────────────────────────────────────────────────────
log "Installing dependencies (npm ci --include=dev)..."
# --include=dev so build tooling (vite, etc., in devDependencies) is installed
# even if this runs in an environment with NODE_ENV=production preset.
npm ci --include=dev
log "Building the web UI (npm run build)..."
npm run build

# ── 3b. Repo ownership ────────────────────────────────────────────────────────
# `npm ci` / `npm run build` above ran as root (this script needs root for the
# systemd unit), leaving node_modules/ and build/ root-owned. The in-app updater
# runs as the SERVICE_USER and must be able to `git pull`, `npm ci`, and
# `npm run build` — so hand it the whole repo. Without this, "Update now" fails
# with EACCES on node_modules.
if [[ "$(id -u)" -eq 0 ]] && id "${SERVICE_USER}" >/dev/null 2>&1; then
  log "Handing repo ownership to ${SERVICE_USER} (so in-app updates work)..."
  chown -R "${SERVICE_USER}" "${REPO_ROOT}" 2>/dev/null || \
    warn "Could not chown ${REPO_ROOT} to ${SERVICE_USER}; in-app updates may fail with EACCES."
fi

# ── 4. Data directory ─────────────────────────────────────────────────────────
log "Data directory: ${DATA_DIR} (owner: ${SERVICE_USER})"
mkdir -p "${DATA_DIR}"
if id "${SERVICE_USER}" >/dev/null 2>&1; then
  chown -R "${SERVICE_USER}" "${DATA_DIR}" 2>/dev/null || \
    warn "Could not chown ${DATA_DIR} to ${SERVICE_USER} (run with sudo?). Continuing."
else
  warn "User '${SERVICE_USER}' does not exist; skipping chown. Pass --user <name> for a real user."
fi

# ── 5. systemd service ────────────────────────────────────────────────────────
if [[ "${INSTALL_SERVICE}" -eq 0 ]]; then
  log "Skipping systemd setup (--no-service)."
  log "Start manually with:  STAGE_UTILITY_DATA=${DATA_DIR} npm start"
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  warn "systemctl not found — this host doesn't use systemd."
  warn "Build is done. Start manually with:  STAGE_UTILITY_DATA=${DATA_DIR} npm start"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  die "Installing the systemd service needs root. Re-run with sudo, or use --no-service."
fi

log "Writing ${UNIT_PATH}..."
cat > "${UNIT_PATH}" <<UNIT
[Unit]
Description=Stage Utility
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${REPO_ROOT}
Environment=STAGE_UTILITY_DATA=${DATA_DIR}
Environment=NODE_ENV=production
Environment=STAGE_UTILITY_FRIENDLY_PORT=${FRIENDLY_PORT}
# Let the (non-root) service user bind the low friendly port (80) so the LAN URL
# needs no port. Least-privilege: grants ONLY the bind-low-port capability.
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=${NODE_BIN} --import tsx ${REPO_ROOT}/server.ts
# `always` (not on-failure) so the in-app updater can restart the service by
# exiting the process after it pulls + rebuilds.
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

log "Enabling and (re)starting the service..."
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

sleep 1
systemctl --no-pager --lines=0 status "${SERVICE_NAME}" || true

# ── 6. Report ─────────────────────────────────────────────────────────────────
LAN_IP="$(node -e 'const n=require("os").networkInterfaces();for(const k in n)for(const a of n[k])if(a.family==="IPv4"&&!a.internal){console.log(a.address);process.exit(0)}' 2>/dev/null || echo "<server-ip>")"
echo
log "Stage Utility is running."
log "  Kiosk display : http://${LAN_IP}/  (or http://${LAN_IP}:${PORT}/)"
log "  Settings      : http://${LAN_IP}/settings-window.html"
log "Configure it in the Settings page → Integrations (Planning Center App ID + Secret, Shure gear)."
log "Logs:  journalctl -u ${SERVICE_NAME} -f"
