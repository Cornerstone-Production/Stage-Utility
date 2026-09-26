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

For that reason a lock that could not be read counts as held for the two restart
controls: Advanced says it couldn't read the lock, both take the guarded look, and
pressing one asks first. **Update now** and the track switch keep the server's
`409` as their check. The failed read is logged on the `[updater]` tag.

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

One further chip, when Planning Center has answered at least once: **PCO quota**,
the requests used against the limit PCO reported on its last response
(`PCO quota 48/100 per 20s`). It turns amber and reads "holding back" once Stage
is deliberately slowing itself down. See
[Rate limits](../integrations/planning-center.md#rate-limits).

The lines carry a date heading whenever the date changes, a source dropdown built
from the `[tag]` each line opens with, a level filter, a text filter, and copy and
download buttons. Only the newest 2,000 matching lines are drawn; filtering still
runs over all of them, and the count says so.

Timestamps are drawn in the **app time zone** (Settings → Advanced), which the
header names. Not the server's UTC and not the viewer's browser zone: a log is
read against a service that happened at a wall-clock time in the building.

### Log tags

A tag is the `[name]` every line opens with — what the source dropdown filters
on. Server code writes its own tag straight into `console.log`/`warn`/`error`.
Browser code carries one too: a failed read or action calls `logToServer(tag,
message)` (or the `useFailedReads` hook that wraps it), and the line reaches
`/log` exactly like a server line, `[tag] message`. A tag whose only work is a
subsystem's own bookkeeping — nothing an operator would search for — is marked
as such rather than given a doc link it doesn't need.

| Tag | What writes it |
|---|---|
| `[action]` | A control's or Companion press refused by the action registry, and why: [Actions](../automation.md#actions) |
| `[app-paths]` | Recovering (or failing to recover) config from a legacy data-directory name across an upgrade |
| `[app-root]` | An ignored or unusable `STAGE_UTILITY_ROOT` override: [Environment](install-and-config.md#environment) |
| `[archive]` | A data-archive read, write or import failure: [Data archive](../data-archive.md) |
| `[attachment-cache]` | Plan attachments cached from Planning Center: prunes, and fetch/redirect/size refusals: [Planning Center](../integrations/planning-center.md) |
| `[attendance-recorder]` | The attendance-trend recorder's debounced save failing to persist |
| `[automation]` | Rules added, changed, removed, saved with issues, or failing to fire; on the browser, the rule list failing to load: [Automation](../automation.md) |
| `[automation-log]` | The Activity log itself failing to persist an entry to disk |
| `[backup]` | The scheduled automatic backup writing, or failing: [Automatic backups](reliability.md#automatic-backups) |
| `[baptism]` | Session-store eviction at the cap, auto-start/arm decisions, raw-event failures; on the browser, a Baptisms card read or delete failing: [Baptisms](../features/scriptview-and-baptisms.md#logging) |
| `[baptism-lane]` | The Session chart's server-side span data dropping a span with an unreadable boundary timestamp: [The Session chart](../features/scriptview-and-baptisms.md#the-session-chart) |
| `[baptism-replay]` | A data-archive rebuild skipping baptism rows it could not place, and why: [Baptisms are merged, never replaced](../data-archive.md#baptisms-are-merged-never-replaced) |
| `[baptism-timer]` | The live timer's own persistence: debounced save failures, a save that failed at shutdown, a dismissed save-failure notice |
| `[bar-config]` | The context bar's one-time migration splitting service type out of a plan item, on the one start that needed it: [The context bar](../features/context-bar.md) |
| `[branding]` | A logo or avatar image failing to externalize to `branding-images/`: [Branding](../features/operator-app.md#branding) |
| `[broadcaster]` | A subscriber's own callback throwing while handling a broadcast — internal plumbing, not an operator signal |
| `[cache-maintenance]` | The daily disk-cache prune (photos, attachments, layout images) failing outright: [Under load](reliability.md#under-load) |
| `[calendar]` | The pushed month-grid view folding or failing a refresh: [Calendar](../integrations/planning-center.md#calendar) |
| `[checklist]` | A pre-service checklist tick failing to save: [Plan notes as a checklist](../integrations/planning-center.md#plan-notes-as-a-checklist) |
| `[clock]` | Browser-side: the on-screen clock's own drift correction reporting a failure |
| `[companion]` | A Companion button press or export fetch, and its result: [Companion](../integrations/companion.md) |
| `[config-snapshot]` | Building or restoring a config snapshot: unreadable settings, id floors that could not carry forward, stores that could not be quieted: [Backups](reliability.md#backups) |
| `[cues]` | Cue-to-Companion-button pairing and state-source inference, and built-in cues: [Cues](../automation.md#cues) |
| `[data-store]` | Any JSON-backed store finding its file corrupt, backing it up and starting fresh: [Under load](reliability.md#under-load) |
| `[device-manager]` | Wireless provider connections starting, stopping, or failing to disconnect: [Wireless](../integrations/wireless.md) |
| `[devices]` | Kiosk device enrollment cleanup after a failed claim: [Kiosk devices](../kiosk-devices.md) |
| `[displays]` | A display's reported screen size failing to record: [Size](../kiosk-devices.md#size) |
| `[encryption]` | The encryption key generated on first run, or rejected as the wrong length: [When credentials all read as "not configured"](reliability.md#when-credentials-all-read-as-not-configured) |
| `[events]` | SSE and poll-transport clients connecting, closing, or expiring: [Polling transport](../display-urls.md#polling-transport) |
| `[history]` | A time correction refused, a rebuild's outcome; on the browser, History or Home cards failing to load: [Attendance and service history](../features/attendance-and-history.md) |
| `[history-edit]` | Merging one recorded service into another: [The service page](../features/attendance-and-history.md#the-service-page) |
| `[integration-manager]` | Config-key validation, and credentials migrating (or failing to migrate) out of `settings.json`: [When a credential could not be moved out of settings.json](reliability.md#when-a-credential-could-not-be-moved-out-of-settingsjson) |
| `[kiosk-responder]` | The UDP discovery responder starting, or a socket/reply error: [Discovery](../kiosk-devices.md#discovery) |
| `[layout-defaults]` | A one-time cleanup of an old layout object's card-ground styling — internal plumbing, not an operator signal |
| `[layout-editor]` | Browser-side: the layout editor's own reads (targets, commands, services, files, saved groups) failing |
| `[layout-images]` | Orphaned uploaded layout images pruned: [Under load](reliability.md#under-load) |
| `[live-poller]` | The live-service tick failing for one integration, and the poller starting: [Winding down between services](reliability.md#winding-down-between-services) |
| `[obs]` | Connection state, and recording/streaming/virtual-camera transitions: [OBS](../integrations/obs.md) |
| `[osc]` | Target init, hostname resolution, and send-socket errors: [OSC](../integrations/osc.md) |
| `[patch]` | Browser-side: the patch sheet or its weekly variant failing to load |
| `[pco]` | Planning Center rate-limit headroom, refused unsafe URLs, and (under `STAGE_UTILITY_DEBUG`) every request: [Planning Center](../integrations/planning-center.md) |
| `[pco-calendar]` | Calendar instances with no start time, left undrawn: [Calendar](../integrations/planning-center.md#calendar) |
| `[photo-cache]` | Person photos cached from Planning Center: prunes, and fetch/redirect/size refusals: [Planning Center](../integrations/planning-center.md) |
| `[plan-export]` | A view bundle built for export to another install, and its counts: [Moving a view between installs](../moving-a-view.md) |
| `[plans]` | The upcoming-plans list refreshing or failing, and the plan switcher's mode: [Switching plans in the editor](../slots.md#switching-plans-in-the-editor) |
| `[prodcom]` | Connection state, transcript source (websocket vs. SSE fallback), and idle/heartbeat timeouts: [ProdCom](../integrations/prodcom.md) |
| `[propresenter]` | Macro triggers and their failures, and unsupported status endpoints: [ProPresenter](../integrations/propresenter.md) |
| `[pvp]` | Polling state, and playlist-tree fetch failures: [ProVideoPlayer](../integrations/provideoplayer.md) |
| `[reaper]` | Polling state, and transport command results: [Reaper](../integrations/reaper.md) |
| `[reconcile]` | Orphaned open recordings (attendance, SPL, service timeline) closed at boot: [What gets recorded](../features/attendance-and-history.md#what-gets-recorded) |
| `[reconnect]` | The switch into or out of service-window-aware backoff: [Winding down between services](reliability.md#winding-down-between-services) |
| `[relaunch]` | The update flow exiting for the service manager to restart the server, as described above |
| `[remote-server]` | The HTTP/SSE server listening, a port conflict and its retries, kiosk discovery failing to start, and (under `STAGE_UTILITY_DEBUG`) every request |
| `[resi]` | Encoder status polling, and broadcast-list availability for encoder names: [Resi](../integrations/resi.md) |
| `[rosstalk]` | Connection state to a Carbonite or Ultrix device: [RossTalk](../integrations/rosstalk.md) |
| `[routes]` | An HTTP handler attempting a second reply after one was already sent — internal plumbing, not an operator signal |
| `[scores]` | Followed teams, and ESPN reachability: [Scores](../integrations/scores.md) |
| `[scriptview]` | Browser-side: ScriptView's settings, types, note categories or rundown failing to load |
| `[scriptview-layouts]` | A one-time migration of saved columns from category names to roles: [Category roles](../features/scriptview-and-baptisms.md#category-roles) |
| `[secrets]` | `secrets.bin` unreadable, or a credential save failing: [When a credential will not save](reliability.md#when-a-credential-will-not-save) |
| `[sennheiser:<id>]` | A Sennheiser wireless connection's protocol trace, only under `SENNHEISER_DEBUG`: [Wireless](../integrations/wireless.md) |
| `[sensource]` | Poll cadence for occupancy and SafeSpace, and an idle consumer waking the poller: [SenSource](../integrations/sensource.md) |
| `[server]` | Process-level boot and shutdown: the data directory in use, unhandled rejections, and uncaught exceptions |
| `[service-recorder]` | The shared logic all three service recordings share: whether a live-service boundary was held or split, and why: [Back-to-back services on one plan](../features/attendance-and-history.md#back-to-back-services-on-one-plan) |
| `[service-timeline]` | The recorded rundown timing: items going live again, and pacing reset by an operator: [What gets recorded](../features/attendance-and-history.md#what-gets-recorded) |
| `[service-timeline-recorder]` | The service-timeline recorder's debounced save failing to persist |
| `[shure:<id>]` | A Shure wireless or charger connection's init and per-channel state: [Wireless](../integrations/wireless.md) |
| `[slots]` | Plan-to-service-type checks and override pruning: [Switching plans in the editor](../slots.md#switching-plans-in-the-editor) |
| `[slots-store]` | Slot-set migration, and copying or removing a display's slots: [Mic slots](../slots.md) |
| `[slug-migration]` | A display renamed off a URL now reserved by `/log` or `/logs`: [Friendly URLs](../display-urls.md#friendly-urls) |
| `[smaart]` | Connection state to a Smaart measurement server: [Smaart](../integrations/smaart.md) |
| `[spectera]` | A Sennheiser Spectera wireless connection's protocol trace, only under `SPECTERA_DEBUG` (an SSE buffer-overflow resync always shows): [Wireless](../integrations/wireless.md) |
| `[spl-recorder]` | The SPL recording resumed or rebuilt from the archive, and archive-close failures: [Sound levels](../features/attendance-and-history.md#sound-levels) |
| `[spl-series]` | A raw SPL sample series failing to read: [Sound levels](../features/attendance-and-history.md#sound-levels) |
| `[stage-controller]` | Layout template and group library changes (saved, updated, deleted) — internal bookkeeping, not an operator signal |
| `[stream-starts]` | The first-seen live timestamp for a streaming platform failing to persist or clear |
| `[surface-migration]` | A one-time internal layout-surface migration — internal plumbing, not an operator signal |
| `[tsl]` | Connection state to a Ross multiviewer over TSL UMD: [Ross MultiViewer](../integrations/ross-tsl.md) |
| `[updater]` | The update flow described above, and (browser side) the update lock failing to read |
| `[view-import]` | Importing a view: plan retyping, patch variants, and preset counts: [Moving a view between installs](../moving-a-view.md) |
| `[wireless]` | Connection setup, credential migration, and meter-rate changes: [Wireless](../integrations/wireless.md) |
| `[youtube]` | The device-code connect flow: code issued, approved, or refused: [YouTube](../integrations/youtube.md) |

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

Above the lists sits **the release's own opening words** — the sentence somebody
wrote because no commit range could produce it, saying whether there is a manual
step or where something has moved. It is the prose the release notes open with,
up to their first heading; headings, bullet lists and fenced commands are left
out, quoted or not, so a dialog never shows an operator a command to type.

It appears after **any** successful update, including one applied automatically,
and stays until you press Dismiss. Closing the tab or reloading does not count —
the notice is held by the server, so it is waiting next time. That is also why a
second browser does not show it again once dismissed.

A release with no usable notes shows the version alone. An install updating from
a git checkout lists commit subjects without headings, since commit subjects
carry no sections.

**Each section says how much it is not showing.** A release's notes carry a
fixed number of bullets and the dialog shows a fixed number of lines, so a busy
release is listed in part — and every section that was cut ends with the count
it cut, above whatever the release itself said about the omission. A section cut
to nothing still appears, as a heading and a count. The **Full changelog** link
at the foot of the release notes is the complete list.

**Fixed is bugs.** Work that made something quicker rather than repairing it —
holding one stream open instead of polling, dropping a field from a
once-per-second read — is listed under **Improved**, so it does not read as a
report of something that had been broken on your install.

**A stable release does not list the fixes that built its own new features.** It
folds in thirty-odd betas, so Fixed would otherwise fill with the polish commits
behind whatever is announced under New — of no use to somebody meeting the
feature whole, and enough of them to push out the fixes to things they already
had. A fix is held back only where its scope both shipped a feature in the same
release and had never appeared before it; a fix to anything that was already
released is always listed. Fixed and Improved each state their own held-back
count at the end of the section, so the filter is never silent. Prereleases list
everything: on the beta track, the fix is the reason to update.

Notes are captured **before** the update runs. Afterwards the update status
describes the next pending release rather than the one just installed, so there
is no later moment when the right answer is still knowable.
