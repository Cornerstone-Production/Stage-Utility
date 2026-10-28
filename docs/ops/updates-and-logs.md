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

### The machines that show screens follow

A Mac running the output helper, and a Windows kiosk, carry software of their own
that the server's update does not replace: the helper app, and the kiosk's launcher.
Each runs an updater that asks the server every five minutes and installs what the
server runs, never during a service on a Mac (whose helper restarts for about three
seconds), so updating the server is the whole job:
[Keeping the helper on the server's version](../kiosk-devices.md#keeping-the-helper-on-the-servers-version).
A machine installed before 1.27.0 needs its installer run once more to get the
updater. Settings → Advanced → Updates → *Update Mac output helpers and Windows kiosks
with this server* turns it off.

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

Which files count is one list, `scripts/build-inputs.mjs`, used by both update scripts:
the interface (`renderer/`, `main/`, `public/`, the HTML documents, the Vite, Tailwind,
PostCSS and TypeScript config) and the public ServiceCue page's Worker source and config.
A checkout with no `build/servicecue/deploy.json` reinstalls and rebuilds on the next
update whatever changed, unless `build/servicecue.failed` says the last build failed to
make it on the commit the update starts from: then only a change to a build input rebuilds
([the marker](servicecue-on-the-web.md#the-copy-every-build-prepares)).

### What's new

The panel lists the pending commits, filtered to what an operator could actually
notice (`changelog.ts`). Types that change nothing an operator could notice — `chore`,
`ci`, `build`, `docs`, `test`, `refactor`, and the legacy `style` — are dropped, along
with merge commits and the release workflow's own `chore(release): vX.Y.Z [skip ci]`
bump. A `revert` is kept whole: the word is the meaning. Without that filter the
commonest thing on offer was an update whose only listed change was the version
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

Timestamps are drawn in the **app time zone** (Settings → Advanced → General), which the
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

A `BUG:` line is the app reporting a mistake in its own code, not in your setup:
the request still went to the right place, and the line names only origins, never
a path or a credential. If you see one, report it.

| Tag | What writes it |
|---|---|
| `[action]` | A control's or Companion press refused by the action registry, and why: [Actions](../automation.md#actions) |
| `[app-paths]` | Recovering (or failing to recover) config from a legacy data-directory name across an upgrade |
| `[app-root]` | An ignored or unusable `STAGE_UTILITY_ROOT` override: [Environment](install-and-config.md#environment) |
| `[archive]` | A data-archive read, write or import failure: [Data archive](../data-archive.md). A raw CSV passed over because it could not be read or stopped taking rows, once per file, with recording going on in the next file: [When a recorded file cannot be read](reliability.md#when-a-recorded-file-cannot-be-read) |
| `[attachment-cache]` | Plan attachments cached from Planning Center: prunes, and fetch/redirect/size refusals; a file that will not download is one line per outage naming the file, its attachment id and why, a reminder if it keeps failing, and one when it downloads again: [Plan files](../integrations/planning-center.md#plan-files) |
| `[attendance-history]` | The attendance records, one file per service: the one-time split of the old single file, and a record, the folder or the old file that could not be read (left as it is), with a save for that service held beside it: [When a recorded file cannot be read](reliability.md#when-a-recorded-file-cannot-be-read) |
| `[attendance-recorder]` | The attendance-trend recorder's debounced save failing to persist, and a closed record that could not be saved, held and retried until it is: [When a recorded service cannot be saved](reliability.md#when-a-recorded-service-cannot-be-saved) |
| `[automation]` | Rules added, changed, removed, saved with issues, failing to fire, or run by hand from a Run button (who ran it, and what came of it); on the browser, the rule list failing to load: [Automation](../automation.md) |
| `[automation-log]` | The Activity log itself failing to persist an entry to disk |
| `[backup]` | The scheduled automatic backup writing, or failing: [Automatic backups](reliability.md#automatic-backups) |
| `[baptism]` | Session-store eviction at the cap, sessions stored more than once under one id, auto-start/arm decisions, raw-event failures; on the browser, a Baptisms card read or delete failing: [Baptisms](../features/servicecue-and-baptisms.md#logging) |
| `[baptism-lane]` | The Session chart's server-side span data dropping a span with an unreadable boundary timestamp: [The Session chart](../features/servicecue-and-baptisms.md#the-session-chart) |
| `[baptism-replay]` | A data-archive rebuild skipping baptism rows it could not place, and why: [Baptisms are merged, never replaced](../data-archive.md#baptisms-are-merged-never-replaced) |
| `[baptism-timer]` | The live timer's own persistence: debounced save failures, a save that failed at shutdown, a dismissed save-failure notice |
| `[bar-config]` | The context bar's one-time migration splitting service type out of a plan item, on the one start that needed it: [The context bar](../features/context-bar.md) |
| `[branding]` | A logo or avatar image failing to externalize to `branding-images/`; the custom tab and home-screen icon being set or removed, a custom icon whose stored file cannot be read, so the built-in one is served (once per file), and, from the browser, the Branding page failing to draw an icon or to open an image in the crop editor: [Branding](../features/operator-app.md#branding) |
| `[broadcaster]` | A subscriber's own callback throwing while handling a broadcast — internal plumbing, not an operator signal |
| `[cache-maintenance]` | The daily disk-cache prune (photos, attachments, layout images, the Mac output helper's cached zips) failing outright: [Under load](reliability.md#under-load) |
| `[calendar]` | The pushed month-grid view folding or failing a refresh: [Calendar](../integrations/planning-center.md#calendar) |
| `[checklist]` | A pre-service checklist tick failing to save: [Plan notes as a checklist](../integrations/planning-center.md#plan-notes-as-a-checklist) |
| `[clock]` | Browser-side: the on-screen clock's own drift correction reporting a failure |
| `[companion]` | A Companion button press or export fetch, and its result: [Companion](../integrations/companion.md) |
| `[config-snapshot]` | Building or restoring a config snapshot: a restore accepted (the files and images it wrote) or refused (each file or image and the rule it broke; nothing written), files, images and `settings.json` keys a restore skipped because this build does not keep them, config files on disk a save would refuse (checked at start-up, left in use), unreadable settings, id floors that could not carry forward, stores that could not be quieted, a backup listing one store under both its old and its current file name, and each stored credential a restore cleared because it would have gone to a new address (or its owner was removed): [Backups](reliability.md#backups) |
| `[cues]` | Cue-to-Companion-button pairing and state-source inference, and built-in cues: [Cues](../automation.md#cues) |
| `[data-store]` | Any JSON-backed store finding its file corrupt, backing it up and starting fresh, and rewriting a save that landed while it did; a store file that is there but cannot be read (the errno is named), so it runs on its defaults and saves to it are refused until a restart, and the same file reading again: [When a store file cannot be read](reliability.md#when-a-store-file-cannot-be-read) |
| `[device-manager]` | Wireless provider connections starting, stopping, or failing to disconnect: [Wireless](../integrations/wireless.md) |
| `[displays]` | A display's reported screen size failing to record: [Size](../kiosk-devices.md#size) |
| `[encryption]` | The encryption key generated on first run, or rejected as the wrong length: [When credentials all read as "not configured"](reliability.md#when-credentials-all-read-as-not-configured) |
| `[events]` | SSE and poll-transport clients connecting, closing, or expiring; channel reports no stream or poll client claimed, dropped and counted when a later report arrives (the first line at once, then at most one a minute): [Polling transport](../display-urls.md#polling-transport), [Channels](../reference/api.md#channels) |
| `[helper-update]` | Mac output helpers and Windows kiosks following this server's version: each machine's decision when it changes (waiting and why, going ahead, up to date), what it reports it did (updated, failed and why, waiting for a login, the helper quit at the Mac, Local Network refused after an update), Update now pressed, a machine that stopped checking: [Keeping the helper on the server's version](../kiosk-devices.md#keeping-the-helper-on-the-servers-version) |
| `[history]` | A time correction refused, a rebuild's outcome; on the browser, History or Home cards failing to load: [Attendance and service history](../features/attendance-and-history.md) |
| `[history-edit]` | Merging one recorded service into another: [The service page](../features/attendance-and-history.md#the-service-page) |
| `[integration-manager]` | Config-key validation; credentials migrating (or failing to migrate) out of `settings.json`; a stored credential cleared because a save changed the address it is sent to, naming the old and new address and never the value: [When a credential could not be moved out of settings.json](reliability.md#when-a-credential-could-not-be-moved-out-of-settingsjson), [Credentials](../integrations/README.md#credentials) |
| `[kiosk-responder]` | The UDP discovery responder starting, a socket/reply error, or the device bindings unreadable, so no probe is answered until they read again; and a device that names this server but is not set up here (released, or claimed on an install since wiped) being told so, once until it is set up here again: [Discovery](../kiosk-devices.md#discovery), [Bindings, and more than one server](../kiosk-devices.md#bindings-and-more-than-one-server) |
| `[kiosk-presence]` | A device that is not a Mac helper output heard for the first time, or again after it aged out (its id, OS and host), whether or not anyone is on Screens; and the list reaching its 256-device limit, once per time it fills. A helper output logs under `[output-helper] output seen` instead: [Discovery](../kiosk-devices.md#discovery) |
| `[last-update]` | The tail of `update.log` replayed at start-up, so the run that ended in this restart is readable: [Diagnosing a failed (or slow) update](#diagnosing-a-failed-or-slow-update) |
| `[layout-defaults]` | The one-time card cleanups on load, with a count: a translucent or older card ground folded to the current card, and an 8% card border raised to 10%: [Layout editor](../reference/layout-editor.md) |
| `[layout-editor]` | Browser-side: the layout editor's own reads (targets, commands, services, files, saved groups) failing, and a saved group failing to save or delete |
| `[layout-images]` | Orphaned uploaded layout images pruned, or the prune skipped because a layout store could not be read: [Under load](reliability.md#under-load) |
| `[live-poller]` | The live-service tick failing for one integration, and the poller starting: [Winding down between services](reliability.md#winding-down-between-services) |
| `[messages]` | Stage messages: each one sent (to which groups, whether an alert, by whom, and the text cut to 120 characters), a send refused and why, an alert cleared and by whom, a reply (to which message, from whom, the text) and a reply refused and why, the walk that decides which views a screen draws stopping at its 256-view cap, a group deleted and from how many screens (and, at start-up and on every save, a group id a screen holds that the config does not have, and from how many it was taken), `saved the groups but could not take deleted groups off the screens` when that step failed after the config saved, `taking unknown groups off the screens was skipped at start-up` when `messaging.json` did not read whole and a screen holds a group (the screens are left alone), a save of the groups and quick messages refused because another window changed them first, the nightly clear and how many messages it removed, `the date moved back` when the time zone moved west and today's messages were kept, the 200-a-day cap dropping the oldest (once a day), the thread failing to save, `checking the day's thread at start-up failed` and `taking unknown groups off the screens at start-up failed` (the server boots regardless), `messaging.json` holding entries or fields that could not be read (each named with the rule it broke) or not being an object, `messages.json` holding messages that could not be read (a count only), and, from the browser, Settings → Messages failing to read or save the groups and quick messages, or being told they changed since the page loaded, and a console failing to send a reply. The browser-side lines are a message that would not send (`could not send that message`), a clear that failed (`could not clear that alert`), a reply that was refused or did not reach the server (`could not send that reply`), a read of the messages that failed (`could not read the stage messages`), and an alert banner that failed to draw and is hidden until the next update (`the alert banner failed to draw`). An alert running out is routine and is not logged: [Stage messages](../features/stage-messages.md) |
| `[obs]` | Connection state, and recording/streaming/virtual-camera transitions: [OBS](../integrations/obs.md) |
| `[osc]` | Target init, hostname resolution, and send-socket errors: [OSC](../integrations/osc.md) |
| `[output-helper]` | A Mac's output heard for the first time (its id, kind and name), claimed (which screen it now shows, and any device it displaced) or released; a bound output showing `/enroll` a token other than the one pinned (`showed a token other than the one pinned for screen …`, once until it matches again, is released or is set up: its token was replaced on the Mac, and it is set up again by releasing it and setting it up, see [Mac output helper](../kiosk-devices.md#mac-output-helper)); a DeckLink output **struggling** (three reports running with frames dropped or 5% or more repeated) and **recovered**; an output that **stopped reporting health**. Ordinary reports are not logged. For the helper's download: the zip's SHA-256 read from the release's API record; a zip fetched from the release and verified against it, or served from the cache; a cached zip hashed again and dropped for fetching again when it no longer matches; older cached releases removed, and a leftover partial download or old release that could not be; a transfer refused or failed, with why (no such release, the release lists no such asset or no digest for it, a malformed digest, GitHub's API rate limit (with when it resets), bad checksum, over the size limit, stalled, no release reachable); and the one notice when `STAGE_UTILITY_TEST_RELEASE_BASE` points the fetch at a test server. Serving `install-macos.sh` or `install-windows.ps1` logs `could not prepare <installer>` with why when the server cannot put its own address into the script, and the request gets a 500: [Mac output helper](../kiosk-devices.md#mac-output-helper), [Installing the Mac output helper](../kiosk-devices.md#installing-the-mac-output-helper) |
| `[patch]` | Browser-side: the patch sheet or its weekly variant failing to load |
| `[pco]` | Planning Center rate-limit headroom, refused unsafe URLs, each read that failed after its retries, named (`[pco] plan items read failed: …`, and the same for the calendar, checklist, plans and the rest — a service order or SPL rundown then reads "Couldn't load the plan"), a live read that failed (`live state unknown until Planning Center answers again`, once per run of failures; Mac helper and ServiceCue page updates wait until `live state known again`), and (under `STAGE_UTILITY_DEBUG`) every request: [Planning Center](../integrations/planning-center.md) |
| `[pco-calendar]` | Calendar instances with no start time, left undrawn: [Calendar](../integrations/planning-center.md#calendar) |
| `[photo-cache]` | Person photos cached from Planning Center: prunes, fetch/redirect/size refusals, and a smaller copy PCO would not give, with what was served instead: [Planning Center](../integrations/planning-center.md#photos) |
| `[plan-export]` | A view bundle built for export to another install, and its counts: [Moving a view between installs](../moving-a-view.md) |
| `[plan-file]` | Browser-side: a Plan file widget still failing to load after its quick retries, with the page it is on and the file name, once per outage rather than on every slow re-check, and one line when that file draws again: [Plan file](../reference/widgets.md#pco--service) |
| `[plans]` | The upcoming-plans list failing, or changing in size (an unchanged refresh is not said), and the plan switcher's mode: [Switching plans in the editor](../slots.md#switching-plans-in-the-editor) |
| `[prodcom]` | Connection state, transcript source (websocket vs. SSE fallback), and idle/heartbeat timeouts: [ProdCom](../integrations/prodcom.md) |
| `[propresenter]` | Macro triggers and their failures, and unsupported status endpoints: [ProPresenter](../integrations/propresenter.md) |
| `[publish]` | [ServiceCue publishing to the web](../features/servicecue-and-baptisms.md#on-the-web): switched on (to which host) or off; the first request the page accepted; the page reached again, with how long it was out; a request failing and the page not accepting what is sent, once per outage with the wait before the next try; `publishing is held` when only a change of address or token can help (the token refused, a rule on the account blocking this server, an address that is not the page, another protocol version, a saved token or address that cannot be used); publishing starting again after the page was deployed from this server; a read for a document failing, so the page keeps its last copy; a document, image or frame the page refused, skipped until it changes; Planning Center's rate-limit headroom holding the refresh, and releasing it; the page no longer holding what it was sent; what the page removed because it is no longer wanted; and the page being asked to drop its copy, or not answering. Never the token |
| `[pvp]` | Polling state, and playlist-tree fetch failures. Also `BUG: a request URL for <origin> was sent to <origin> instead`, written when a request URL had to be moved back onto the configured ProVideoPlayer host (see [Code scanning](../reference/code-scanning.md#credentialed-requests)): [ProVideoPlayer](../integrations/provideoplayer.md) |
| `[reaper]` | Polling state, and transport command results: [Reaper](../integrations/reaper.md) |
| `[reconcile]` | Orphaned open recordings (attendance, SPL, service timeline) closed at boot: [What gets recorded](../features/attendance-and-history.md#what-gets-recorded) |
| `[reconnect]` | The switch into or out of service-window-aware backoff: [Winding down between services](reliability.md#winding-down-between-services) |
| `[relaunch]` | The server exiting on purpose and expecting its service manager to bring it back: the Restart button, a config import, a snapshot recall, a crash. On macOS (Homebrew and one-line installs) launchd can park the automatic respawn, so each of those exits is paired with a `launchctl kickstart`, and one line names the job being kicked (`com.stageutility.server`, or `com.cornerstone.stage-utility` on an install made before that name; `homebrew.mxcl.<formula>` on Homebrew). `cannot kick this server back up through launchd: …` means the job could not be identified: either none of the known jobs is loaded, or `launchctl` could not be run (the reason says which). Nothing was kicked, so launchd may leave the server stopped until `sudo launchctl kickstart system/<label>` is run by hand; the restart, import and recall replies carry the same reason. Also the warning when nothing will start the server again. An update does not use this path: on a one-line install the installer signals the server and launchd relaunches it, and a Homebrew update kickstarts the service itself |
| `[remote-server]` | The HTTP/SSE server listening, a port conflict and its retries, kiosk discovery failing to start, and (under `STAGE_UTILITY_DEBUG`) every request |
| `[resi]` | Encoder status polling, and broadcast-list availability for encoder names: [Resi](../integrations/resi.md) |
| `[rosstalk]` | Connection state to a Carbonite or Ultrix device: [RossTalk](../integrations/rosstalk.md) |
| `[routes]` | An HTTP handler attempting a second reply after one was already sent — internal plumbing, not an operator signal |
| `[scores]` | Followed teams, and ESPN reachability: [Scores](../integrations/scores.md) |
| `[screens]` | Server-side. A one-time pass on the first start after an upgrade that takes the role an older build stored on each screen out of the data: one line for each screen it had to do something for (kept read-only behind a wall copy of a console, or kept live by making its view a console or giving it a control-surface copy, either of which is kept out of the sidebar and given the `contain` fit its layout had), `reused the copy left by an interrupted upgrade: "<name>"` for a copy a start that died part-way had already saved, then `role from view: N screens checked, M changed`, and nothing when no screen carries a stored role: [The view decides what a screen is](../reference/data-model.md#surfaces-displays-and-consoles). And one line whenever a write changes whether a screen's buttons work, from routing a screen to another view, from changing what a view is for, or from deleting a view a control surface was showing: `"Lobby TV" is now a control surface (shows "Booth controls")`, or `… is now read-only (shows …)` (`shows nothing` after a delete). Browser-side, the Screens page failing to start, renew or stop its scan for displays on the network: [Kiosk devices](../kiosk-devices.md) |
| `[safespace]` | `BUG: a request URL for <origin> was sent to <origin> instead`, written when a SafeSpace request had to be moved back onto SafeSpace's own host. Never carries a path, which is the credential: [Code scanning](../reference/code-scanning.md#safespace) |
| `[secrets]` | `secrets.bin` unreadable, or a credential save failing: [When a credential will not save](reliability.md#when-a-credential-will-not-save) |
| `[security]` | The host-name check: refusal on or off at start-up and when switched, and `host-names.json` unreadable (refusal then off until it reads); a name not on the list the first time it is answered (the request and the address it came from); a name's first refusal, then one line an hour with how many more, and a `Host` that is not a name refused the same way; the seen list reaching its 50-name cap and the name it forgot (these three share five lines a minute, and the rest are counted on one line); each name accepted when refusal first turns on and how many were left waiting; event streams closed because their name is now refused; a name added, accepted, removed or dismissed by the operator; the seen list failing to save (it is retried each minute): [SECURITY.md](../../SECURITY.md) |
| `[sennheiser:<id>]` | A Sennheiser wireless connection's protocol trace, only under `SENNHEISER_DEBUG`: [Wireless](../integrations/wireless.md) |
| `[sensource]` | Poll cadence for occupancy and SafeSpace, and an idle consumer waking the poller. Also `BUG: a request URL for <origin> was sent to <origin> instead`, written when a token or API request had to be moved back onto SenSource's own host: [SenSource](../integrations/sensource.md) |
| `[server]` | Process-level boot and shutdown: the data directory in use, unhandled rejections, and uncaught exceptions |
| `[service-recorder]` | The shared logic all three service recordings share: whether a live-service boundary was held or split, and why, and an item already on air before a record opened not taken as its opening item: [Back-to-back services on one plan](../features/attendance-and-history.md#back-to-back-services-on-one-plan) |
| `[service-timeline]` | The recorded rundown timing: items going live again, and pacing reset by an operator: [What gets recorded](../features/attendance-and-history.md#what-gets-recorded). The timing records' own files, as for `[attendance-history]`: [When a recorded file cannot be read](reliability.md#when-a-recorded-file-cannot-be-read) |
| `[service-timeline-recorder]` | The service-timeline recorder's debounced save failing to persist, and a closed record that could not be saved, held and retried until it is: [When a recorded service cannot be saved](reliability.md#when-a-recorded-service-cannot-be-saved) |
| `[servicecue]` | A saved ServiceCue file moved in from its old name on upgrade (`scriptview-*.json` to `servicecue-*.json`), or both names found and the new one kept with the old left untouched; a move that failed; browser-side, ServiceCue's settings, types, note categories, rundown or plan list failing to load, a `?plan=` the service type does not have, or a display's text size the server would not keep |
| `[servicecue-bundle]` | The build preparing the public ServiceCue page for upload (`build/servicecue/`): its failing, which leaves the update itself to go on and this server with nothing to upload: [The copy every build prepares](servicecue-on-the-web.md#the-copy-every-build-prepares) |
| `[servicecue-deploy]` | Keeping the public ServiceCue page itself up to date ([Keeping it up to date](servicecue-on-the-web.md#keeping-it-up-to-date)): each decision once (deploying and why, the page current, left alone as newer or another build, waiting for a live service, the service window or the service times), the files uploaded and already held, the build deployed, a deploy that left the page on the old build, every failure with Cloudflare's code and words and when it is tried again, a token set or cleared, and the Cloudflare credentials removed with a change of page address. Never the token |
| `[servicecue-layouts]` | A one-time migration of saved columns from category names to roles: [Category roles](../features/servicecue-and-baptisms.md#category-roles) |
| `[shure:<id>]` | A Shure wireless or charger connection's init and per-channel state: [Wireless](../integrations/wireless.md) |
| `[slots]` | Plan-to-service-type checks and override pruning: [Switching plans in the editor](../slots.md#switching-plans-in-the-editor) |
| `[slots-store]` | Slot-set migration, and copying or removing a display's slots: [Mic slots](../slots.md) |
| `[slug-migration]` | A display renamed off a URL now reserved by `/log` or `/logs`: [Friendly URLs](../display-urls.md#friendly-urls) |
| `[smaart]` | Connection state to a Smaart measurement server: [Smaart](../integrations/smaart.md) |
| `[spectera]` | A Sennheiser Spectera wireless connection's protocol trace, only under `SPECTERA_DEBUG` (an SSE buffer-overflow resync always shows): [Wireless](../integrations/wireless.md) |
| `[spl-history]` | The SPL records' own files, as for `[attendance-history]`: [When a recorded file cannot be read](reliability.md#when-a-recorded-file-cannot-be-read) |
| `[spl-recorder]` | The SPL recording resumed or rebuilt from the archive, or resumed from its stored record because the archive could not be read, and archive-close failures: [Sound levels](../features/attendance-and-history.md#sound-levels). A closed record that could not be saved, held and retried until it is: [When a recorded service cannot be saved](reliability.md#when-a-recorded-service-cannot-be-saved) |
| `[spl-series]` | A raw SPL sample series failing to read: [Sound levels](../features/attendance-and-history.md#sound-levels) |
| `[stage-controller]` | Layout template and group library changes (saved, updated, deleted) — internal bookkeeping, not an operator signal. Also a screen being made (`createScreen`) and a view changing what it is for (`setViewRole view=… → console, screens: …`, with the screens showing it, which change with it; and `… not made: the screens changed since the operator was asked` when the screens they were shown are no longer the ones it would change), and, when a multi-step screen write fails, a warning naming the step that failed, what was put back, and anything that could not be: [Screens](../features/operator-app.md#screens). At startup, the migrations of views and screens skipped because `views.json` or `settings.json` could not be read: [When a store file cannot be read](reliability.md#when-a-store-file-cannot-be-read) |
| `[stream-starts]` | The first-seen live timestamp for a streaming platform failing to persist or clear |
| `[surface-migration]` | A one-time pass that makes a view holding a button a console, and so the screens showing it control surfaces, on an install that predates surfaces: [Upgrading an existing install](../reference/data-model.md#upgrading-an-existing-install) |
| `[tsl]` | Connection state to a Ross multiviewer over TSL UMD: [Ross MultiViewer](../integrations/ross-tsl.md) |
| `[updater]` | The update flow described above, and (browser side) the update lock failing to read |
| `[video-export]` | Exporting video feeds: the count, and whether passwords or relay ports were included: [Moving feeds between servers](../integrations/video-feeds.md#moving-feeds-between-servers) |
| `[video-import]` | Importing video feeds: how many were added, replaced, kept, already the same or skipped (with the reason), and whether passwords or relay ports were applied: [Moving feeds between servers](../integrations/video-feeds.md#moving-feeds-between-servers) |
| `[video]` | Relay starts (once per process), exits and restarts, downloads and checksums, port conflicts, a relay left over from the last run, the relay not answering, reconcile and proxy failures, feeds going live, delayed or offline, a pull feed's device not answering the relay's dial or the page's camera check, B-frames detected, a push feed's password rotating, a pull feed's stored password cleared because its address moved to another camera or off an encrypted scheme, or because a new feed landed on the slot of an earlier one, a screen struggling with a feed or playing it smoothly again, and a screen lagging on a feed (holding the delay in its own browser) or no longer; browser-side, a Video widget's feed failing on a screen (once per failing streak: the first failure, a reminder at most every 5 minutes, the recovery), a feed falling back to HLS on a screen and back to WebRTC, a feed refused by a screen's own HLS switch and allowed again, a screen's playback stats failing to read and reading again, and a widget crashing: [Video feeds](../integrations/video-feeds.md#logging) |
| `[view-import]` | Importing a view: plan retyping, patch variants, and preset counts: [Moving a view between installs](../moving-a-view.md) |
| `[wireless]` | Connection setup, credential migration, a stored password cleared because the connection's address or provider changed, and meter-rate changes: [Wireless](../integrations/wireless.md) |
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
`\x1b`. Long values are cut at 200 characters with an ellipsis, a stack trace
at 2,000, and a raw ProdCom frame under `PRODCOM_DEBUG=1` at 10,000. Seeing `\n` in the middle of a plan title on this page means the title
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

Inside it, the update script's own narration is prefixed `[update]`, and a
Homebrew run writes `[brew] run starting <time>` before the output of `brew` and
`launchctl`. Only the `[update]` lines are copied into `/log` while the update
runs; the rest stays in the file.

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
once-per-second read, or giving a table a little more room (a `polish` commit) —
is listed under **Improved**, so it does not read as a report of something that
had been broken on your install.

**A hand-written notice and the generated lists share a heading.** A release
whose notice (the opening words above) carries its own **Breaking**, **New**,
**Improved** or **Fixed** list gets one list under one heading: the written
bullets first, then the generated ones, then anything the notice wrote under a
sub-heading of its own.

**A stable release does not list the fixes that built its own new features.** It
folds in thirty-odd betas, so Fixed would otherwise fill with the small
corrections behind whatever is announced under New — of no use to somebody
meeting the feature whole, and enough of them to push out the fixes to things
they already had. A fix or improvement is held back only where its scope both
shipped a feature in the same release and had never appeared before it, or where
its author marked it `Beta-only`; a change to anything that was already released
is always listed. Fixed and Improved each state their own held-back count at the
end of the section, so the filter is never silent. Prereleases list everything:
on the beta track, the fix is the reason to update.

Notes are captured **before** the update runs. Afterwards the update status
describes the next pending release rather than the one just installed, so there
is no later moment when the right answer is still knowable.
