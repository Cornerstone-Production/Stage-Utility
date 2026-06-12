#!/usr/bin/env bash
#
# install.sh — One-command installer for Stage Monitor on Linux + systemd.
#
# Run from a checked-out copy of the repo:
#     sudo ./scripts/install.sh
#
# Idempotent: re-run after a `git pull` to update an existing install
# (re-installs deps, rebuilds the UI, and restarts the service).
#
# Environment / flag overrides:
#     STAGE_MONITOR_DATA=/path   data directory (default: /var/lib/stage-monitor)
#     --data-dir <path>          same as STAGE_MONITOR_DATA
#     --user <name>              run the service as this user (default: $SUDO_USER)
#     --no-service               build only; don't install/enable the systemd unit
#
set -euo pipefail

# ── Constants ───────────────────────────────────────────────────────────────
SERVICE_NAME="stage-monitor"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
PORT=8788
MIN_NODE_MAJOR=24

# Repo root = parent of this script's directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Defaults (overridable) ────────────────────────────────────────────────────
DATA_DIR="${STAGE_MONITOR_DATA:-/var/lib/stage-monitor}"
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

# ── 2. Build ──────────────────────────────────────────────────────────────────
log "Repo: ${REPO_ROOT}"
cd "${REPO_ROOT}"
log "Installing dependencies (npm ci)..."
npm ci
log "Building the web UI (npm run build)..."
npm run build

# ── 3. Data directory ─────────────────────────────────────────────────────────
log "Data directory: ${DATA_DIR} (owner: ${SERVICE_USER})"
mkdir -p "${DATA_DIR}"
if id "${SERVICE_USER}" >/dev/null 2>&1; then
  chown -R "${SERVICE_USER}" "${DATA_DIR}" 2>/dev/null || \
    warn "Could not chown ${DATA_DIR} to ${SERVICE_USER} (run with sudo?). Continuing."
else
  warn "User '${SERVICE_USER}' does not exist; skipping chown. Pass --user <name> for a real user."
fi

# ── 4. systemd service ────────────────────────────────────────────────────────
if [[ "${INSTALL_SERVICE}" -eq 0 ]]; then
  log "Skipping systemd setup (--no-service)."
  log "Start manually with:  STAGE_MONITOR_DATA=${DATA_DIR} npm start"
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  warn "systemctl not found — this host doesn't use systemd."
  warn "Build is done. Start manually with:  STAGE_MONITOR_DATA=${DATA_DIR} npm start"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  die "Installing the systemd service needs root. Re-run with sudo, or use --no-service."
fi

log "Writing ${UNIT_PATH}..."
cat > "${UNIT_PATH}" <<UNIT
[Unit]
Description=Stage Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${REPO_ROOT}
Environment=STAGE_MONITOR_DATA=${DATA_DIR}
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} --import tsx ${REPO_ROOT}/server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

log "Enabling and starting the service..."
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

sleep 1
systemctl --no-pager --lines=0 status "${SERVICE_NAME}" || true

# ── 5. Report ─────────────────────────────────────────────────────────────────
LAN_IP="$(node -e 'const n=require("os").networkInterfaces();for(const k in n)for(const a of n[k])if(a.family==="IPv4"&&!a.internal){console.log(a.address);process.exit(0)}' 2>/dev/null || echo "<server-ip>")"
echo
log "Stage Monitor is running."
log "  Kiosk display : http://${LAN_IP}:${PORT}/"
log "  Settings      : http://${LAN_IP}:${PORT}/settings-window.html"
log "Configure it in the Settings page → Integrations (Planning Center App ID + Secret, Shure gear)."
log "Logs:  journalctl -u ${SERVICE_NAME} -f"
