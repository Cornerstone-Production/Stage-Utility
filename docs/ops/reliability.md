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
  backed up rather than overwritten. Recorded services are one file each, so
  persisting a live service does not rewrite your whole history.
- **Disk caches are pruned** by age and size. Photos and plan attachments are
  cached, and images are served immutable so a screen fetches each one once.
- **Updates skip what they can** — no reinstall unless dependencies changed, no
  rebuild unless the interface did.

## Winding down between services

Integrations do not retry at full speed all week. Rehearsal and service windows are
derived from Planning Center — the earliest plan time minus a lead (default 2 h)
through the last plus a tail (default 1 h) — and connections back off toward a
dormant ceiling outside them. The Planning Center poll stretches from 4 seconds to
5 minutes.

Windows are recomputed on boot, hourly with the plan refresh, and when the schedule
settings change. Two safeguards: nothing sleeps past the moment the next window
opens, and if the schedule cannot be worked out — no credentials, a failed fetch,
the feature off — everything stays at its active cadence rather than going quiet.

Tunable under **Settings → Advanced → Server**.

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
| `scriptview-config.json`, `scriptview-layouts.json`, `scriptview-roles.json` | ScriptView columns and category roles |
| `patch.json` | the stage patch sheet |
| `automation-rules.json`, `automation-settings.json` | rules, and simulate/disarm |
| `osc-targets.json`, `rosstalk-targets.json`, `rosstalk-settings.json` | control targets |
| `wireless-connections.json` | receivers and chargers (never their passwords) |
| `kiosk-devices.json` | which machine drives which screen |
| `bar-config.json`, `saved-colors.json` | the context bar's arrangement, and your colours |
| `baptism-triggers.json`, `scores-favourites.json` | per-plan baptism items, followed teams |
| `history-milestones.json` | the dates you marked on the History trend chart |
| `branding-images/`, `layout-images/` | uploaded images, named by content hash |

**What it observed** — deliberately not restored, because it describes this
machine's history rather than how you set it up:

| | |
|---|---|
| `spl-history/`, `attendance-history/`, `service-timeline/` | recorded services, one file each |
| `archive/` | the raw samples behind them — see [data archive](../data-archive.md) |
| `baptism.json` | baptism sessions |
| `checklist-ticks.json` | which checklist rows are ticked, per plan |
| `automation-log.json` | the Activity log |
| `signals.json` | the values Companion reads |
| `stream-starts.json` | when each platform was first seen live |
| `update-notices.json` | which release has been announced |

**Neither** — never in a backup, and never restored:

| | |
|---|---|
| `cache/photos/`, `cache/attachments/` | cached Planning Center photos and plan files |
| `server.log`, `update.log` | log history, replayed into `/log` on boot |
| `secrets.bin` | integration and wireless credentials, AES-256-GCM encrypted |
| `encryption.key` | 32-byte key, generated on first run, mode `600` |
| `snapshots/`, `backups/` | saved config snapshots, and what the scheduler wrote |

Which half a file lands in is declared where the file is defined and checked by
the test suite, so a new store cannot quietly miss a backup.

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
check rather than skipping an interval, and a machine that was switched off runs
one backup when it returns rather than one per interval it missed.

**Keeping the key out of a synced backup.** By default the key sits beside
`secrets.bin` so the service can decrypt unattended at boot, which means it travels
with any copy of the directory. To separate them, set `STAGE_UTILITY_KEY_FILE` to a
path you control, or `STAGE_UTILITY_KEY` to a raw 32-byte key in the environment
(`openssl rand -base64 32`), in which case no key file is written. Threat model is
in [SECURITY.md](../../SECURITY.md).
