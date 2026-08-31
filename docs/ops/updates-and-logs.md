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

### The update lock

While a Planning Center service is live, or any recorder is open (SPL, attendance,
service history), `GET /api/update/lock` reports `active` with the reasons. Every
control that would restart the server — **Update now**, **Restart**, the update
**track switch**, and the **Restart now** on a deferred update — is guarded, and
Advanced prints the reasons above them.

Guarded is not disabled. A live service can go wrong and the operator may need to
restart in the middle of one, so each control still opens a confirm dialog whose
only way forward is an explicit override. `POST /api/update/apply` and
`/api/update/track` enforce that on the server too, refusing with `409 locked`
unless the body carries `override: true`; the two restart controls are guarded by
the dialog alone.

What the lock changes is how the controls read: an amber lock in place of the
action's own icon, a label saying that pressing it now is an override, and — for
the two that are normally the accent primary — a drop to the secondary weight.
The guarded look follows being **pressable**, so a control its own rules have
already disabled (mid-update, nothing to install, the track already selected)
keeps its plain label: it cannot reach the override, so it does not offer one.

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
(`log-buffer.ts`, last 10,000 lines). It's LAN-open by default; set
`STAGE_UTILITY_LOG_TOKEN` to require `?token=…`.

`/logs` is an alias: it redirects to `/log`, carrying the query string across, so
a token typed against either spelling works. `/log` is the canonical URL and is
what the app itself links to. Both are reserved, so neither can be taken as a
display slug.

`/logs` was a legal display slug before it became this alias. A display already
holding it is renamed at the next start — see
[Friendly URLs](../display-urls.md#friendly-urls) — and the change is logged
under `[slug-migration]`.

The token gate covers `/log`, `/logs` and `/api/log` alike. A 401 on any of them
means the token is missing or wrong, not that the server is down. An unauthorised
`/logs` answers 401 rather than redirecting, so a client that does not follow
redirects cannot read the refusal as an open page.

### What the page shows

A health strip across the top, then the lines.

The strip is state, not text scraped from the log: the running version, uptime,
the time zone every timestamp is drawn in, how many warnings and errors the
buffer holds, and one chip per **configured** integration with its connection
state and message, worst first. Integrations nobody has set up are left out.
This matters because a connection that has been retrying for days is silent by
design — the services log the first failure and then back off quietly — so the
log alone cannot tell you a box is unreachable.

The lines carry a date heading whenever the date changes, a source dropdown built
from the `[tag]` each line opens with, a level filter, a text filter, and copy and
download buttons. Only the newest 2,000 matching lines are drawn; filtering still
runs over all of them, and the count says so.

Timestamps are drawn in the **app time zone** (Settings → Advanced), which the
header names. Not the server's UTC and not the viewer's browser zone: a log is
read against a service that happened at a wall-clock time in the building.

### Why a value on the page can read `\n`

One record per line is what makes the page readable, and plenty of what gets
logged comes from outside the app: a plan title typed into Planning Center, a
config key posted to `/api/integrations/:id/config`, a device's reply, an error
message from an integration. A newline inside any of those would otherwise start
a second line that looks exactly like a record the server wrote — most misleading
at the moment the log matters most.

So every outside value is escaped on its way into a log line. A control character
is shown rather than obeyed: a newline reads `\n`, a tab `\t`, anything else
`\x1b`. Long values are cut at 200 characters with an ellipsis, and a stack trace
at 2,000. Seeing `\n` in the middle of a plan title on this page means the title
really contains one — not that the page is broken.

### Timestamps that run backwards

The buffer is not chronological, and cannot be. On boot the previous run's
`server.log` tail is replayed with its original timestamps, and then `update.log`
is replayed after it — with timestamps that predate lines already above it. The
page marks the step down with

```
↑ earlier than the line above — replayed from before a restart
```

and draws a date heading at every date change, so a jump back across midnight is
visible rather than looking like a clock fault. Filter by full date, never by
time of day.

Nothing is re-sorted. The replayed blocks are meaningful as blocks, and
interleaving them by timestamp would scatter one update's output through
unrelated lines.

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

**A stable release does not list the fixes that built its own new features.** It
folds in thirty-odd betas, so Fixed would otherwise fill with the polish commits
behind whatever is announced under New — of no use to somebody meeting the
feature whole, and enough of them to push out the fixes to things they already
had. A fix is held back only where its scope both shipped a feature in the same
release and had never appeared before it; a fix to anything that was already
released is always listed. The count held back is stated at the end of Fixed, so
the filter is never silent. Prereleases list everything: on the beta track, the
fix is the reason to update.

Notes are captured **before** the update runs. Afterwards the update status
describes the next pending release rather than the one just installed, so there
is no later moment when the right answer is still knowable.
