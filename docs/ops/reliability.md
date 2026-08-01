# Reliability, backups and data

How the app behaves under load and over time, and where your data lives.

## Reliability & efficiency

The live layer is tuned for many always-on kiosks:

- **SSE:** a single multiplexed stream with **per-connection channel filtering** (a
  display only receives the channels it uses), **broadcast-on-change** (e.g. `pco:live`
  and `spl:metrics` emit on change, not every tick), payloads **stringified once** per
  broadcast, a **heartbeat + backpressure guard** that reaps dead clients, and an
  **opt-in shared-worker relay** (`stage:sharedSse`) that shares one connection across
  tabs on the same machine.
- **PCO:** tiered response caches, consolidated `plan_times` + team-position calls, and
  **429 backoff** cut request volume; the live timer stays uncached.
- **Storage:** the DataStore uses **atomic writes** (temp + rename) and is
  **corruption-safe** on load (bad files are backed up, never overwritten). Photo and
  plan-attachment disk caches are pruned by age + size.
- **Polling & assets:** static assets are gzipped; ProPresenter thumbnails are cached
  and its poll interval is configurable; charger/heartbeat polls are slowed; live-history
  broadcasts are throttled to ~5 s.
- **Updater:** skips `npm ci` / `npm run build` when an update doesn't touch deps or the
  renderer, and can switch between the **beta** and **main** update tracks in-app.

## Backups & portability

A **full config snapshot** (Settings → Advanced) can be **saved/recalled** in-app and
**downloaded/uploaded** as a file to move a configuration between machines. Integration
**secrets are excluded** from snapshots (they stay AES-256-GCM encrypted on the box). A
server **log viewer** is available at `/log`.

## Data, secrets & backups

State persists in a **data directory** — `$STAGE_UTILITY_DATA` if set, otherwise
`~/.stage-utility`:

- `settings.json` — non-secret config (service type, plan mode, outputs, branding, …)
- `branding-images/` — the logo and avatar files `settings.json` points at (content-hashed)
- `views.json` — view definitions (kind + config; custom views carry their layout)
- `slots.json` — slot sets, keyed by view + service type
- `layout-templates.json` — saved custom-layout library; `presets.json` — slot presets
- `layout-groups.json` — reusable object groups; `scriptview-layouts.json` + `scriptview-config.json` — ScriptView presets + landing curation
- `layout-images/` — images uploaded for custom-layout objects
- `spl-history/` — per-item SPL recordings, **one file per service**, for History
- `attendance-history/` — per-service attendance; `service-timeline/` — per-service item timing
- `archive/` — the raw samples behind those records, one directory per service ([data archive](../data-archive.md))
- `baptism.json` — baptism sessions; `osc.json` — OSC button/target definitions
- `secrets.bin` — integration secrets, **AES-256-GCM encrypted**
- `encryption.key` — 32-byte key, auto-generated on first run (mode `600`)
- `cache/photos/` — cached PCO photos
- `cache/attachments/` — cached PCO plan files (stage plots etc.), keyed by attachment id

A `*.json.migrated` file is an older single-document store left in place after it
was split per service — safe to delete once you are happy the split took.

**Back up this directory.** If you lose `encryption.key`, the encrypted secrets are
unrecoverable and you'll need to re-enter every credential.

**Keeping the key out of a synced/backed-up data dir.** By default the key sits next to
`secrets.bin` so the service can decrypt unattended at boot. If you back up or sync the data
dir, the key travels with the ciphertext — to avoid that, store the key elsewhere via
`STAGE_UTILITY_KEY_FILE=/abs/path/to/key` (key file at a path you control) or
`STAGE_UTILITY_KEY=<base64-or-hex>` (a raw 32-byte key supplied via the environment; no key
file is written — generate one with `openssl rand -base64 32`). See
[SECURITY.md](SECURITY.md) for the threat model.
