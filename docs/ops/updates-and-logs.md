# In-app updates & the /log page

## How updating works

The server runs from a git checkout under a service manager (systemd
`Restart=always` / launchd `KeepAlive` / NSSM). An in-app update (Settings →
Advanced → Updates) spawns a **detached** `scripts/update.sh` (`update.ps1` on
Windows) that does:

```
git pull --ff-only  →  npm ci --include=dev  →  npm run build
```

The server stays alive through pull/install/build, polling two files the script
writes (`update-progress.json`, `update-result.json`) and broadcasting sub-phase
progress on the `update:status` SSE channel. On success the script writes the
result file, sleeps briefly, then **kills the server** — the service manager
relaunches it on the new build. On failure it writes the result and leaves the
server running on the old build.

`npm ci` and the build only run when the update actually changed the lockfile /
renderer inputs; a backend-only update just restarts (the backend runs via tsx).

### Progress reconciliation across the restart

Because a successful update restarts the server, the settings page's SSE socket
drops and reconnects. `update:status` **hydrates on every SSE (re)connect**
(`remote-server.ts`), so the reconnecting page immediately sees the finished
state — it can't get stuck on the last-seen step. Two independent signals then
reload the page onto the new assets (guarded so only one fires):

- `server:hello` carrying a new code version, and
- `update:status` returning to a non-`updating` phase with no error.

## The /log page

`/log` shows the server's recent console output — an in-memory ring buffer
(`log-buffer.ts`, last 500 lines). It's LAN-open by default; set
`STAGE_UTILITY_LOG_TOKEN` to require `?token=…`.

### Diagnosing a failed (or slow) update

The in-memory buffer is wiped on restart, and updates always restart — so update
activity is also written to a **persistent, size-capped** `update.log` in the
data dir (`~/.stage-utility/`), and its tail is replayed into `/log` at startup,
tagged `[last-update]`. After an update you can open `/log` and see the whole
run: apply start (from→to SHA, commits behind), each phase (pull / install /
build / restarting), success or FAILED, and the git/npm output.

`update.log` is **hard-capped at 128 KB** — trimmed to the last 128 KB on every
append and at startup (always at a line boundary), and each run only appends a
bounded ~8 KB tail. It holds roughly the last dozen runs and can never grow
without bound.

## Files

- `main/services/updater.ts` — the update state machine + lifecycle logging
- `main/services/update-log.ts` — persistent, capped `update.log` + startup replay
- `main/services/log-buffer.ts` — in-memory `/log` ring buffer
- `scripts/update.sh` / `update.ps1` — the detached pull/install/build/restart script
- `renderer/settings/sections/advanced-section.tsx` — the Updates panel + progress bar
