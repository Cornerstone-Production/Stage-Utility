# Reliability and data

How the app behaves over a long run, and where your data lives.

## Under load

Built for a room full of always-on screens.

- **One event stream per client**, filtered to the channels that screen renders,
  broadcast on change rather than on a timer, serialised once per push, with a
  heartbeat that reaps dead clients. See [network traffic](network-traffic.md).
- **Planning Center requests are pooled and cached** in tiers, with backoff on rate
  limits. The live countdown stays uncached.
- **Writes are atomic** — temp file then rename — and a file that will not parse is
  backed up rather than overwritten. One that cannot be read at all is never
  taken for empty: see
  [When a store file cannot be read](#when-a-store-file-cannot-be-read), and
  for recordings,
  [When a recorded file cannot be read](#when-a-recorded-file-cannot-be-read).
  Recorded services are one file each, so persisting a live service does not
  rewrite your whole history, and one that cannot be saved does not stop the next
  from recording: see
  [When a recorded service cannot be saved](#when-a-recorded-service-cannot-be-saved).
- **Disk caches are pruned.** Photos and plan attachments go by age and size, and
  the Mac output helper's downloads (`cache/output-helper/`) are cut back to the
  running version. Images are served immutable so a screen fetches each one once.
- **Updates skip what they can** — no reinstall unless dependencies changed, no
  rebuild unless the interface did.

## Winding down between services

Integrations do not retry at full speed all week. Rehearsal and service windows are
derived from Planning Center — the earliest plan time minus a lead (**Lead time
before rehearsal**, default 120 minutes) through the last plus a tail (**Keep
active after service ends**, default 60 minutes) — and connections back off
toward a dormant ceiling outside them (**Idle retry interval**, default 30
minutes). The Planning Center poll stretches from 4 seconds to 5 minutes.

Windows are recomputed on boot, hourly with the plan refresh, and when the schedule
settings change. Two safeguards: nothing sleeps past the moment the next window
opens, and while no window is still to come — no credentials, a fetch that failed,
nothing planned — the schedule counts as unknown, so reconnects keep the 2-minute
cap and the Planning Center poll stays at 4 seconds rather than going quiet. The
switch into and out of that mode is logged on the `[reconnect]` tag.

Tunable under **Settings → Advanced → Server**, where switching **Wake around service
times** off gives every integration a fixed 2-minute retry instead.

## Where your data lives

`$STAGE_UTILITY_DATA` if set. Otherwise it depends on how the app was installed —
the running server prints its own path in **Settings → Advanced**:

| Install | Data directory |
|---|---|
| Linux (one-line installer) | `/var/lib/stage-utility` |
| macOS (one-line installer) | `/usr/local/var/stage-utility` |
| Windows | `%ProgramData%\stage-utility` |
| Homebrew | `$(brew --prefix)/var/stage-utility` |
| Checkout, or no installer | `~/.stage-utility` |

**Your configuration** — everything a config backup carries:

| | |
|---|---|
| `settings.json` | service type, plan mode, outputs, integration config, branding, backup schedule, time zone |
| `views.json`, `slots.json` | view definitions and slot sets |
| `presets.json`, `layout-templates.json`, `layout-groups.json` | saved slot presets and layout libraries |
| `notes.json` | what an operator typed into a notes object |
| `servicecue-config.json`, `servicecue-layouts.json`, `servicecue-roles.json` | ServiceCue columns and category roles. An install that has them as `scriptview-*.json` has them renamed on the next start; a backup taken before that restores into the new names. A release older than 1.25.0 reads only the old names, so a server switched back to one (for example from the beta track to an older stable) shows ServiceCue with no layouts until it runs 1.25.0 or later again; the files are not touched |
| `servicecue-publish.json` | whether ServiceCue is published to the web, and the address of its page. Restored switched on, it has no token until one is entered again: the card then says so |
| `patch.json` | the stage patch sheet |
| `automation-rules.json`, `automation-settings.json` | rules, and simulate/disarm |
| `osc-targets.json`, `rosstalk-targets.json`, `rosstalk-settings.json` | control targets |
| `wireless-connections.json` | receivers and chargers (never their passwords) |
| `kiosk-devices.json` | which machine drives which screen |
| `bar-config.json`, `saved-colors.json` | the context bar's arrangement, and your colours |
| `baptism-triggers.json`, `scores-favourites.json` | per-plan baptism items, followed teams |
| `history-milestones.json` | the dates you marked on the History trend chart |
| `video-feeds.json` | the [video feeds](../integrations/video-feeds.md) and the relay's ports, never a camera or publish password |
| `messaging.json` | the stage-message groups, quick messages and quick replies |
| `branding-images/`, `layout-images/` | uploaded images, named by content hash |

**What it observed** — deliberately not restored, because it describes this
machine's history rather than how you set it up:

| | |
|---|---|
| `spl-history/`, `attendance-history/`, `service-timeline/` | recorded services, one file each |
| `archive/` | the raw samples behind them — see [data archive](../data-archive.md) |
| `baptism.json` | baptism sessions |
| `messages.json` | the day's stage messages: a message describes one day, and last winter's would only reappear on this Sunday's screens |
| `checklist-ticks.json` | which checklist rows are ticked, per plan |
| `automation-log.json` | the Activity log |
| `signals.json` | the values Companion reads |
| `stream-starts.json` | when each platform was first seen live |
| `update-notices.json` | which release has been announced |
| `video-seen.json` | when each video feed was last confirmed live |

**Neither** — never in a backup, and never restored:

| | |
|---|---|
| `cache/photos/`, `cache/attachments/` | cached Planning Center photos and plan files |
| `cache/output-helper/` | the Mac output helper's zips, one folder per release, downloaded again when missing |
| `video-relay/` | the video relay's pinned MediaMTX download and its generated config, fetched again on a fresh machine. See [Video feeds](../integrations/video-feeds.md#the-relay-and-its-switch) |
| `update-track`, `update-progress.json`, `update-result.json`, `update-live.log`, `update-restart-pending` | the updater's own state: the track this install follows, and the files an update in flight and one waiting for its restart leave |
| `server.log`, `update.log` | log history, replayed into `/log` on boot |
| `secrets.bin` | integration and wireless credentials and the ServiceCue publishing token, AES-256-GCM encrypted |
| `encryption.key` | 32-byte key, generated on first run, mode `600` |
| `snapshots/`, `backups/` | saved config snapshots, and what the scheduler wrote |

Which half a file lands in is declared where the file is defined and checked by
the test suite, so a new store cannot quietly miss a backup. The same files, one
row each, are in [Data model](../reference/data-model.md#stored-data).

A `*.json.migrated` file is an older store kept after its contents were split into
per-service files. Safe to delete.

### Backups only prune their own files

Automatic backups delete old copies to honour "keep N", and match only the names
they wrote themselves (`config-<stamp>.json`, `archive-<stamp>.zip`). Pointing
the destination at a folder that already holds other files is safe — anything
this app did not write is left alone.

### When credentials all read as "not configured"

Usually the key, not the file. `secrets.bin` is only readable with the key that
wrote it, so a wrong or missing one makes every integration look disconnected at
once — most often `$STAGE_UTILITY_KEY` set on a box that already has an
`encryption.key`, or a key file on a mount that was not up at boot.

The file is left untouched when it cannot be read, so **restore the original key
and restart** and everything comes back in place. Re-entering credentials instead
writes a new file and sets the old one aside as `secrets.bin.unreadable-*` — still
recoverable with the right key, but only from that copy. Check `/log` first: the
reason is logged at startup.

### When a credential will not save

A credential is held in memory only once it is on disk. If the write fails — a
read-only data directory, a full disk, a mount that went away — the save reports
the failure, nothing changes in memory, and the field goes on showing the value
the file still holds. There is no state where the app agrees a credential was
saved and a restart disagrees.

The reason is on `/log` under `[secrets]`, naming the errno:

```
[secrets] save FAILED (EACCES: permission denied, open '…/secrets.bin'). Nothing
was changed in memory either, so the value being read now is the one the file
still holds. Fix the permissions or the mount and save again.
```

Fix the cause and save again — the retry is an ordinary save, with nothing left
over from the attempt that failed.

### When a store file cannot be read

Every JSON store in the data directory (`settings.json`, `views.json`,
`kiosk-devices.json` and the rest) is read once and then served from memory. A
missing file is a first run and starts from defaults. A file that is there and
cannot be read — permissions after running the server as another user, a failing
card, a directory where the file should be — is never treated as empty:

- **The server keeps running.** That store is served as its defaults, in memory
  only, and every read retries the file. A store needed at startup does not stop
  the server starting, so `/log` stays reachable.
- **Nothing is saved to it** once a read has failed, until the server restarts.
  A save reports the failure, and the file is left exactly as it was. Not when
  the file reads again either: what the server built from the defaults at boot,
  the screens for one, would replace the real file on the next save.
- **Nothing is decided from the defaults.** Start-up migrations of views and
  screens are skipped, layout images are not pruned, kiosk discovery answers no
  probe while `kiosk-devices.json` cannot be read (a screen that hears no answer
  keeps its server and probes again), and the device routes fail rather than
  answer from an empty list. With `automation-rules.json` unreadable the cue
  manifest, states and YAML fail rather than list no cues, so Home Assistant
  marks the cue entities unavailable instead of removing them, the app's own
  cue buttons are gone, and rule edits are refused.
- **A backup** fails rather than leaving the file out, and the same goes for an
  uploaded image it cannot read.

Expect the pages backed by that store to look empty while it lasts. That is the
defaults, not your data, which is still on disk. With `settings.json` unreadable
the app also follows the host clock rather than its configured time zone, so
schedules and history days run in the host's zone, which is UTC on most servers.

The reason is on `/log` under `[data-store]`, once per file until it reads again:

```
[data-store] settings.json could not be read (EACCES): EACCES: permission denied,
open '…/settings.json'. Running on its defaults without saving them, and refusing
saves to it until the server restarts. Fix the permissions or the disk, then
restart.
```

Fix the cause, then restart the server. A read after the fix logs
`[data-store] … is readable again; restart the server to save to it`, and some
pages show the real data from then on, but saves stay refused until the restart.

### When a recorded file cannot be read

Recordings follow a different rule from the stores above, because nothing may
stop a live service recording. A recorded file that is there and cannot be read
is never written over, and recording carries on beside it:

- **A service record** (one file per service in `spl-history/`,
  `attendance-history/` and `service-timeline/`) that cannot be read or will not
  parse is left as it is. The service is missing from History, and opening it
  answers that its record could not be read rather than that it was never
  recorded. Saves for
  that service go to `<name>.json.held-<when the server started>` beside it until
  the server restarts, and History shows that copy. A record still unreadable
  after a restart starts another held file, each holding what its run recorded.
  A folder that cannot be listed holds every save the same way.
- **A raw CSV** (`archive/<date>_<service>/spl.csv` and the rest; see
  [Data archive](../data-archive.md)) that cannot be read, or stops taking rows
  mid-service, is passed over: rows go on into the next file of its roll
  (`spl.2.csv`), which every reader already reads, starting with the row that
  failed. A failure of the machine rather than the file (out of file handles,
  memory or space) passes nothing over: that row is lost, and the next one
  tries the same file again.
- **Nothing is decided from the gap.** While any service record cannot be read,
  the data archive's export, inspect and import refuse (an import took that
  service for new and replaced it), and so does the History workbook; a
  scheduled backup that includes the archive fails, writing nothing and keeping
  its older copies.
  That service cannot be edited in History (merge, delete, trim, rebuild,
  recalculate, item times); every other service can. A raw file that cannot be
  read refuses a merge with nothing moved, fails the SPL chart and the baptism
  lane for that service rather than drawing part of it, and resumes SPL from
  its stored record rather than rebuilding from the rows that did read. An
  import merging into one leaves it as it is and lists it as not written.

Each is on `/log`, once per file:

```
[attendance-history] st1-p1-t1.json in attendance-history could not be read
(EACCES): EACCES: permission denied, open '…/st1-p1-t1.json'. Left as it is,
missing from history, and a save for that service goes to a .held file beside it
until the server restarts. Fix the file, then restart.
[attendance-history] saving st1:p1:t1 to st1-p1-t1.json.held-2026-10-18T14-02-11-512Z
rather than over st1-p1-t1.json, because …
[archive] 2026-10-18_st1-p1-t1/spl.csv could not be read (EACCES). Recording spl
into the next file beside it, and leaving this one as it is.
```

Fix the cause, then restart. A file passed over in the raw archive is read with
the rest once it reads again. A held record is not folded back in for you: it is
the part of that service recorded while the record could not be read, so compare
the two and keep what you want. For SPL and the rundown timing,
**Rebuild from raw** on the service page derives the record again from the raw
rows, which hold the whole service.

### When a recorded service cannot be saved

A save that fails outright — the record folder not writable, the disk full —
does not stop recording either. When a service closes, at the split to the next
service on the same plan or when the plan leaves item mode, the closed record is
published to History and the next service's record opens on that same tick,
whether or not the save landed. A record that did not save is held in memory and
saved again every few seconds (every minute for SPL) until it lands. Until then:

- Opening that service shows the held copy, and a service that comes back
  resumes from it. The History list, exports and backups read what is on disk,
  so they leave the service out, or show the copy from before the failure.
- History edits to it, delete included, and an archive import over it are
  refused with a 409 (`code: "unsaved"`): each would work from the copy on disk
  and drop the held one.

Held in memory only: a restart before the save lands loses that service's record.
For SPL and the rundown timing, **Rebuild from raw** recovers it from the raw
archive when an earlier copy of the record reached disk; a service with nothing
saved has no History row to rebuild. A write that hangs rather than fails, such as a
stalled network mount, still holds up the tick it is on.

```
[service-timeline-recorder] could not save st1:p1:t1 (EACCES: permission denied,
open '…'); recording carries on, and the save is retried every 4 s. A restart
before it lands loses that service.
[service-timeline-recorder] still could not save st1:p1:t1 (EACCES: …); still retrying
[service-timeline-recorder] saved st1:p1:t1 on retry
```

The "still could not save" line repeats every ten minutes while it fails.

### When a credential could not be moved out of `settings.json`

A box upgrading from a build that stored a credential as ordinary config moves it
into `secrets.bin` on the next start. If that write cannot happen — a read-only
data directory, a full disk, `EACCES` after an install changed ownership — the box
**still starts**, and says so twice:

- an `[integration-manager]` line on `/log` naming how many credentials, why, and
  that they are still in every config snapshot;
- a note on each affected integration's row in Settings → Integrations, which
  stays there whatever the connection does.

Nothing is lost: the credentials are left exactly where they were, so fixing the
disk or the permissions and restarting completes the move. Until then they ride
into every config snapshot, and any of them that had not already reached
`secrets.bin` is not available to its integration.

## Backups

**Back up this directory.** Lose `encryption.key` and the encrypted credentials
cannot be recovered — you would re-enter every one.

Two backups exist in the app, and they cover different things:

- **Settings → Advanced → Data → Config snapshots** — a config snapshot, saved
  in-app or downloaded as a file, for moving a configuration between machines.
  Credentials are deliberately excluded, so the file is safe to store.
- **Settings → Advanced → Data → Data archive** — recorded services and their
  raw samples. See [data archive](../data-archive.md).

## Automatic backups

**Settings → Advanced → Data → Automatic backups.** Writes a config snapshot, and
optionally the data archive, on an interval you choose — keeping the most recent
few and deleting the rest.

Leaving the destination blank keeps them in the data directory, which does not
survive a disk failure. Point it at a mounted network share and the copies land
off the machine; the app only writes to a path, so anything the OS can mount
works — SMB, NFS, an external disk — with no credentials stored here.

A failed run leaves the existing backups untouched and is retried on the next
check rather than skipping an interval. A config file or uploaded image that is
there but cannot be read fails the run rather than being left out of it. A
machine that was switched off runs one backup when it returns rather than one per
interval it missed.

**Keeping the key out of a synced backup.** By default the key sits beside
`secrets.bin` so the service can decrypt unattended at boot, which means it travels
with any copy of the directory. To separate them, set `STAGE_UTILITY_KEY_FILE` to a
path you control, or `STAGE_UTILITY_KEY` to a raw 32-byte key in the environment
(`openssl rand -base64 32`), in which case no key file is written. Threat model is
in [SECURITY.md](../../SECURITY.md).
