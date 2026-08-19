# In-app updates & the /log page

## How updating works

The server runs under a service manager (systemd `Restart=always` / launchd
`KeepAlive` / a Windows service). An in-app update (Settings → Advanced → Updates)
spawns a **detached** `scripts/update.sh` (`update.ps1` on Windows) that does:

```
fetch  →  fast-forward to the target release  →  npm ci --include=dev  →  npm run build
```

The target is a **release tag**, not the tip of the branch — see
[distribution.md](distribution.md). The merge is `--ff-only`, so a checkout that has
somehow diverged fails loudly instead of having its history rewritten underneath it.

The server stays alive through pull/install/build, polling two files the script
writes (`update-progress.json`, `update-result.json`) and broadcasting sub-phase
progress on the `update:status` SSE channel. On success the script writes the
result file, sleeps briefly, then **kills the server** — the service manager
relaunches it on the new build. On failure it writes the result and leaves the
server running on the old build.

### When the reinstall and rebuild are skipped

`npm ci` and the build only run when they are actually needed; a backend-only update
just restarts, because the backend runs via tsx.

That decision compares the **content** of `package.json` and `package-lock.json` at
each revision, with the root version removed (`scripts/manifest-changed.mjs`), rather
than matching filenames. Every release carries the workflow's own version bump, which
rewrites both manifests without changing a single dependency:

```
chore(release): v1.9.2-beta.2 [skip ci]
  package.json      | 2 +-
  package-lock.json | 4 ++--
```

A filename rule fires on that every time, so the skip never happened. Anything
unreadable or unparseable is treated as changed, so an unknown state does the work
rather than skipping it.

### What's new

The panel lists the pending commits, filtered to what an operator could actually
notice (`changelog.ts`). Types that produce no release — `chore`, `ci`, `build`,
`docs`, `test`, `refactor`, `style` — are dropped, along with merge commits and the
release workflow's own `chore(release): vX.Y.Z [skip ci]` bump. Without that filter
the commonest thing on offer was an update whose only listed change was the version
number being written down.

A subject that does not parse as a conventional commit is kept rather than dropped:
an unrecognised line is more likely to be a real change than something to hide. When
nothing survives the filter the panel is hidden entirely, rather than showing a
heading over an empty list.

### Why the banner can stay quiet while `behind` is not zero

Two counts are tracked. `behind` is the literal git distance to upstream;
`behindUserFacing` is how much of it an operator would notice, filtered the same way
the changelog is. The banner reads the second.

They differ constantly, because the release workflow pushes its own
`chore(release): vX.Y.Z [skip ci]` commit *after* the merge that triggered it — so
every merge leaves exactly one of those trailing behind a machine that has already
updated. Announcing that as "1 update available" is how a banner gets ignored. The
version line says a bump is pending, and **Update now** still applies it.

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


## Logs across restarts

`/log` holds the last 10,000 lines, mirrored to `server.log` in the data directory
and replayed on boot with their original timestamps — so the run-up to a restart,
a crash or an update is still there afterwards. The file is capped at 4 MB.

## What an update reports

The update narrates itself into `/log` as it runs: the commit range, the subject of
every commit arriving, how many files changed, and whether the reinstall and
rebuild are needed or being skipped.

```
57dd812 -> 8904fed (35 commits)
what changed:
  perf(sse): split volatile slot telemetry onto its own channel
  refactor: retire the DisplayInfo shim from state
86 file(s) changed
dependencies unchanged — skipping npm ci
```

npm and vite's own output stays in `update.log` rather than filling `/log` with
progress bars.

## What you are told, and when

Three things, each shown once:

**A toast when a release becomes available.** Once per version, not once per
check — and the version is only marked as announced when the toast actually
reaches a connected browser. An update found overnight with nobody looking is
not spent on an empty room; it waits until somebody opens the app.

Pressing *Check now* still reports every time. That answers a button press, so
it is not rationed.

**A dot on Advanced** while an update is available. It follows availability, not
whether the toast was seen: dismissing a toast leaves the dot until the update is
actually installed.

**A dialog after a successful update**, showing the version and what changed,
grouped as Breaking, New, Changed, Improved and Fixed. Breaking is listed first
and is never truncated away.

It appears after **any** successful update, including one applied automatically,
and stays until you press Dismiss. Closing the tab or reloading does not count —
the notice is held by the server, so it is waiting next time. That is also why a
second browser does not show it again once dismissed.

A release with no usable notes shows the version alone. An install updating from
a git checkout lists commit subjects without headings, since commit subjects
carry no sections.

Notes are captured **before** the update runs. Afterwards the update status
describes the next pending release rather than the one just installed, so there
is no later moment when the right answer is still knowable.
