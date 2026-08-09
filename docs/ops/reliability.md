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

Tunable under **Settings → Advanced → Network & behavior**.

## Where your data lives

`$STAGE_UTILITY_DATA` if set, otherwise `~/.stage-utility` (`/var/lib/stage-utility`
on a Linux install).

| | |
|---|---|
| `settings.json` | non-secret config — service type, plan mode, outputs, branding |
| `views.json`, `slots.json` | view definitions and slot sets |
| `presets.json`, `layout-templates.json`, `layout-groups.json` | saved slot presets and layout libraries |
| `scriptview-*.json`, `patch.json`, `automation-*.json`, `osc.json` | per-feature config |
| `branding-images/`, `layout-images/` | uploaded images, named by content hash |
| `spl-history/`, `attendance-history/`, `service-timeline/` | recorded services, one file each |
| `archive/` | the raw samples behind them — see [data archive](../data-archive.md) |
| `baptism.json` | baptism sessions |
| `cache/photos/`, `cache/attachments/` | cached Planning Center photos and plan files |
| `server.log`, `update.log` | log history, replayed into `/log` on boot |
| `secrets.bin` | integration and wireless credentials, AES-256-GCM encrypted |
| `encryption.key` | 32-byte key, generated on first run, mode `600` |

A `*.json.migrated` file is an older store kept after its contents were split into
per-service files. Safe to delete.

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

## Backups

**Back up this directory.** Lose `encryption.key` and the encrypted credentials
cannot be recovered — you would re-enter every one.

Two backups exist in the app, and they cover different things:

- **Settings → Advanced → Backup & restore** — a config snapshot, saved in-app or
  downloaded as a file, for moving a configuration between machines. Credentials
  are deliberately excluded, so the file is safe to store.
- **Settings → Advanced → Data archive** — recorded services and their raw samples.
  See [data archive](../data-archive.md).

## Automatic backups

**Settings → Advanced → Automatic backups.** Writes a config snapshot, and
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
