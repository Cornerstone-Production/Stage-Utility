#!/usr/bin/env bash
#
# update.sh — Applies an in-app update, then triggers a restart.
#
#   fast-forward to a release tag → npm ci → npm run build
#   on success: write the result file + kill the running server (the service
#               manager — systemd Restart=always / launchd KeepAlive / NSSM —
#               relaunches it with the new build).
#   on failure: write the result file and leave the running server untouched.
#
# Spawned detached by main/services/updater.ts (also runnable by hand). Inputs
# come from env vars:
#   STAGE_UPDATE_REPO        repo root (default: this script's parent dir)
#   STAGE_UPDATE_BRANCH      branch to pull (default: current branch)
#   STAGE_UPDATE_TAG         release tag to land on; empty = follow the branch tip
#   STAGE_UPDATE_NODE_DIR    dir holding node/npm, prepended to PATH
#   STAGE_UPDATE_SERVER_PID  server pid to kill on success
#   STAGE_UPDATE_RESULT      path to write the JSON result file
set -uo pipefail

REPO="${STAGE_UPDATE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
[ -n "${STAGE_UPDATE_NODE_DIR:-}" ] && PATH="${STAGE_UPDATE_NODE_DIR}:${PATH}"
BRANCH="${STAGE_UPDATE_BRANCH:-$(git -C "$REPO" rev-parse --abbrev-ref HEAD)}"
RESULT="${STAGE_UPDATE_RESULT:-$REPO/update-result.json}"
PROGRESS="${STAGE_UPDATE_PROGRESS:-$REPO/update-progress.json}"
# Persistent, size-capped update log (server trims it; we only append a bounded
# tail per run so it can't balloon). Empty = don't persist (e.g. run by hand).
ULOG="${STAGE_UPDATE_LOG:-}"

cd "$REPO" || exit 1
# The live log goes somewhere the (still-running) server can tail, so /log shows
# what is happening DURING the update rather than only a summary afterwards. Falls
# back to a temp file when run by hand with no data dir wired in.
LOG="${STAGE_UPDATE_LIVE_LOG:-$(mktemp)}"
: >"$LOG" 2>/dev/null || LOG="$(mktemp)"
# Commit before the pull — lets us diff what changed and skip the (slow) reinstall
# / rebuild when an update doesn't touch them.
OLD_REV="$(git rev-parse HEAD 2>/dev/null || echo none)"

# Publish the current step so the (still-running) server can broadcast progress.
write_progress() {
  printf '{"step":"%s","at":"%s"}' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$PROGRESS" 2>/dev/null || true
}

# Write {ok, finishedAt, log} via node (guaranteed present — we're updating a
# node app and NODE_DIR is on PATH), which handles JSON escaping safely.
# Append this run's outcome + a bounded tail of its output to the persistent
# update log, so the git/npm detail survives the restart and shows in /log. The
# server hard-caps the file's size; the `tail -c` keeps any single run small.
persist_run() {
  [ -n "$ULOG" ] || return 0
  {
    printf '%s [update.sh] ==== %s on %s finished: %s ====\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "${STAGE_UPDATE_CHECKOUT:+track-switch}${STAGE_UPDATE_CHECKOUT:-update}" \
      "$BRANCH" "$1"
    tail -c 8000 "$LOG" 2>/dev/null
  } >>"$ULOG" 2>/dev/null || true
}

write_result() {
  node -e 'const fs=require("fs");let log="";try{log=fs.readFileSync(process.argv[3],"utf8").slice(-4000)}catch{}fs.writeFileSync(process.argv[2],JSON.stringify({ok:process.argv[1]==="true",finishedAt:new Date().toISOString(),log}))' \
    "$1" "$RESULT" "$LOG" 2>/dev/null || true
  persist_run "$([ "$1" = "true" ] && echo success || echo FAILED)"
}

{
  write_progress pull
  # A tag is verified code (the release workflow tests and builds before tagging);
  # the branch tip may still be in CI or have failed it. TAG is resolved by the
  # server, which orders versions properly — a shell `sort -V` ranks a prerelease
  # above its own release. Empty TAG = the track has never released, so follow the
  # tip rather than refusing to update at all.
  TAG="${STAGE_UPDATE_TAG:-}"
  echo "[update] git fetch --tags --force origin $BRANCH"
  git fetch --tags --force origin "$BRANCH" || { echo "[update] git fetch failed (offline?)"; write_result false; exit 1; }

  if [ -n "$TAG" ] && ! git rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null; then
    echo "[update] tag $TAG not found after fetch — falling back to the branch tip"
    TAG=""
  fi
  TARGET="${TAG:-origin/$BRANCH}"

  if [ -n "${STAGE_UPDATE_CHECKOUT:-}" ]; then
    # Switching tracks: point the local branch at the target, wherever it was.
    echo "[update] git checkout -B $BRANCH $TARGET"
    git checkout -B "$BRANCH" "$TARGET" || { echo "[update] git checkout failed"; write_result false; exit 1; }
  else
    # --ff-only so a box that has somehow diverged fails loudly instead of having
    # its history rewritten underneath it.
    echo "[update] git merge --ff-only $TARGET"
    git merge --ff-only "$TARGET" || { echo "[update] git merge failed (diverged or offline)"; write_result false; exit 1; }
  fi
  [ -n "$TAG" ] && echo "[update] now on release $TAG"
  # Decide what's actually needed. The backend runs via tsx (no build), so a
  # backend-only update just needs a restart. Reinstall only when the lockfile
  # changed; rebuild only when renderer/build inputs changed. Default to doing the
  # work whenever we can't tell (no OLD rev, or build/ missing).
  NEW_REV="$(git rev-parse HEAD 2>/dev/null || echo none)"
  if [ "$OLD_REV" != "none" ] && [ "$NEW_REV" != "none" ] && [ "$OLD_REV" != "$NEW_REV" ]; then
    echo "[update] $(git rev-parse --short "$OLD_REV") -> $(git rev-parse --short "$NEW_REV") ($(git rev-list --count "$OLD_REV..$NEW_REV" 2>/dev/null || echo '?') commits)"
    echo "[update] what changed:"
    git log --no-merges --pretty=format:'[update]   %s' "$OLD_REV..$NEW_REV" 2>/dev/null | head -40
    echo ""
  fi
  NEED_INSTALL=1
  NEED_BUILD=1
  if [ "$OLD_REV" != "none" ] && [ "$NEW_REV" != "none" ] && [ -d build ]; then
    CHANGED="$(git diff --name-only "$OLD_REV" "$NEW_REV" 2>/dev/null || echo "")"
    echo "[update] $(printf '%s\n' "$CHANGED" | grep -c .) file(s) changed"
    NEED_INSTALL=0; NEED_BUILD=0
    # The manifests are judged by CONTENT, not filename. Every release carries a
    # version bump that rewrites package.json and package-lock.json without
    # changing a single dependency — matching on the path made this skip fire on
    # every update, so it never once saved the work it exists to save.
    MANIFEST="$(node "$REPO/scripts/manifest-changed.mjs" "$OLD_REV" "$NEW_REV" 2>/dev/null || echo '{"deps":true,"manifest":true}')"
    case "$MANIFEST" in *'"deps":true'*) NEED_INSTALL=1; NEED_BUILD=1 ;; esac
    case "$MANIFEST" in *'"manifest":true'*) NEED_BUILD=1 ;; esac
    # Any renderer/build input change → rebuild the bundle.
    if echo "$CHANGED" | grep -qE '^(renderer/|index\.html|vite\.config|tailwind\.config|postcss\.config|tsconfig)'; then NEED_BUILD=1; fi
  fi

  if [ "$NEED_INSTALL" = "1" ]; then
    write_progress install
    echo "[update] npm ci --include=dev"
    # --include=dev is REQUIRED: the service runs with NODE_ENV=production (set in
    # the systemd unit), which this detached updater inherits. Under that env npm
    # omits devDependencies by default — but the build tooling (vite, etc.) lives
    # in devDependencies, so a plain `npm ci` installs prod-only deps and the next
    # step fails with "vite: not found". Forcing dev deps keeps the build working.
    npm ci --include=dev || { echo "[update] npm ci failed"; write_result false; exit 1; }
  else
    echo "[update] dependencies unchanged — skipping npm ci"
  fi

  if [ "$NEED_BUILD" = "1" ]; then
    write_progress build
    echo "[update] npm run build"
    npm run build || { echo "[update] npm run build failed"; write_result false; exit 1; }
  else
    echo "[update] no renderer changes — skipping npm run build (backend runs via tsx)"
  fi
} >>"$LOG" 2>&1

# auto-install mode: the build is applied but the operator chooses when the
# displays go dark. Leave a marker the app reports as "restart pending" and stop
# here — the running process keeps serving the OLD build until someone restarts.
if [ -n "${STAGE_UPDATE_DEFER_RESTART:-}" ]; then
  write_result true
  if [ -n "${STAGE_UPDATE_RESTART_PENDING:-}" ]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$STAGE_UPDATE_RESTART_PENDING" 2>/dev/null || true
  fi
  echo "[update] build applied; restart deferred (auto-install mode)" >>"$LOG" 2>&1
  exit 0
fi

write_progress restarting
write_result true

# Let the HTTP response flush, then restart by exiting the server.
sleep 2
if [ -n "${STAGE_UPDATE_SERVER_PID:-}" ]; then
  kill "$STAGE_UPDATE_SERVER_PID" 2>/dev/null || true
fi
