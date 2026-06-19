#!/usr/bin/env bash
#
# update.sh — Applies an in-app update, then triggers a restart.
#
#   git pull --ff-only → npm ci → npm run build
#   on success: write the result file + kill the running server (the service
#               manager — systemd Restart=always / launchd KeepAlive / NSSM —
#               relaunches it with the new build).
#   on failure: write the result file and leave the running server untouched.
#
# Spawned detached by main/services/updater.ts (also runnable by hand). Inputs
# come from env vars:
#   STAGE_UPDATE_REPO        repo root (default: this script's parent dir)
#   STAGE_UPDATE_BRANCH      branch to pull (default: current branch)
#   STAGE_UPDATE_NODE_DIR    dir holding node/npm, prepended to PATH
#   STAGE_UPDATE_SERVER_PID  server pid to kill on success
#   STAGE_UPDATE_RESULT      path to write the JSON result file
set -uo pipefail

REPO="${STAGE_UPDATE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
[ -n "${STAGE_UPDATE_NODE_DIR:-}" ] && PATH="${STAGE_UPDATE_NODE_DIR}:${PATH}"
BRANCH="${STAGE_UPDATE_BRANCH:-$(git -C "$REPO" rev-parse --abbrev-ref HEAD)}"
RESULT="${STAGE_UPDATE_RESULT:-$REPO/update-result.json}"

cd "$REPO" || exit 1
LOG="$(mktemp)"

# Write {ok, finishedAt, log} via node (guaranteed present — we're updating a
# node app and NODE_DIR is on PATH), which handles JSON escaping safely.
write_result() {
  node -e 'const fs=require("fs");let log="";try{log=fs.readFileSync(process.argv[3],"utf8").slice(-4000)}catch{}fs.writeFileSync(process.argv[2],JSON.stringify({ok:process.argv[1]==="true",finishedAt:new Date().toISOString(),log}))' \
    "$1" "$RESULT" "$LOG" 2>/dev/null || true
}

{
  echo "[update] git pull --ff-only origin $BRANCH"
  git pull --ff-only origin "$BRANCH" || { echo "[update] git pull failed (non-fast-forward or offline)"; write_result false; exit 1; }
  echo "[update] npm ci --include=dev"
  # --include=dev is REQUIRED: the service runs with NODE_ENV=production (set in
  # the systemd unit), which this detached updater inherits. Under that env npm
  # omits devDependencies by default — but the build tooling (vite, etc.) lives
  # in devDependencies, so a plain `npm ci` installs prod-only deps and the next
  # step fails with "vite: not found". Forcing dev deps keeps the build working.
  npm ci --include=dev || { echo "[update] npm ci failed"; write_result false; exit 1; }
  echo "[update] npm run build"
  npm run build || { echo "[update] npm run build failed"; write_result false; exit 1; }
} >>"$LOG" 2>&1

write_result true

# Let the HTTP response flush, then restart by exiting the server.
sleep 2
if [ -n "${STAGE_UPDATE_SERVER_PID:-}" ]; then
  kill "$STAGE_UPDATE_SERVER_PID" 2>/dev/null || true
fi
