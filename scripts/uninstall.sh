#!/usr/bin/env bash
#
# uninstall.sh — Remove the Stage Monitor systemd service.
#
#     sudo ./scripts/uninstall.sh
#
# Leaves the data directory untouched (it holds your encryption key + config).
# Its path is printed so you can back it up or remove it deliberately.
#
set -euo pipefail

SERVICE_NAME="stage-monitor"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

log() { printf '\033[1;36m[uninstall]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[uninstall]\033[0m %s\n' "$*" >&2; exit 1; }

command -v systemctl >/dev/null 2>&1 || die "systemctl not found; nothing to uninstall."
[[ "$(id -u)" -eq 0 ]] || die "Removing the service needs root. Re-run with sudo."

# Surface the data dir from the unit before deleting it.
DATA_DIR=""
if [[ -f "${UNIT_PATH}" ]]; then
  DATA_DIR="$(sed -n 's/^Environment=STAGE_MONITOR_DATA=//p' "${UNIT_PATH}" | head -n1)"
fi

if systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
  log "Stopping and disabling ${SERVICE_NAME}..."
  systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
fi

if [[ -f "${UNIT_PATH}" ]]; then
  log "Removing ${UNIT_PATH}..."
  rm -f "${UNIT_PATH}"
  systemctl daemon-reload
fi

log "Service removed."
log "Data directory left intact${DATA_DIR:+: ${DATA_DIR}} — remove it manually if you no longer need your config/secrets."
