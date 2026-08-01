# Data archive — keep every sample, and make it portable

**Status:** draft for review.

Retain the raw readings behind every recorded metric, on disk, in a format that
survives the app — so a calculation can be redone later, and a rebuilt machine can
be given its history back.

---

## Why

A metric was changed and could not be applied to anything already recorded.

The SPL recorder samples **every second** while a service is live and folds each
reading straight into `max` / `leq` / `count`. **The sample is then discarded.** One
service is ~4,500 ticks across ~10 metrics — 45,000 readings — reduced to about 30
numbers per plan item.

When the average was corrected from an arithmetic mean of decibels to an energy
average (Leq), every past service was stuck with the wrong figure. The maths was
recoverable; the data was not. Nothing about that was specific to SPL — it is what
happens whenever the only thing kept is the answer.

## What is discarded today

| Source | Rate | Kept today |
|---|---|---|
| Smaart (SPL, per metric) | **1 Hz** while live | ✗ folded to max/leq/count, samples gone |
| Wireless (RF + battery, per channel) | **1 Hz** (`meterRateMs`) | ✗ live only, never written |
| SenSource (attendance, occupancy) | 45s (min 10s) | ✓ samples stored on the record |
| PCO Live (current item) | 1s live / 4s idle | ✓ item start/end on the timeline |
| ProPresenter / OBS / REAPER / OSC | poll or push | ✗ live only |
| ProdCom (transcript) | push | ✗ live only |
| Baptism timer | operator-driven | ✓ per-person durations are the raw data |

Two of these destroy genuinely analysable data: **SPL** and **wireless telemetry**.
**Only SPL is in v1** — wireless is deferred (see Out of scope), because nothing
depends on it yet and it is two thirds of the bytes.

The rest are **state changes**, not measurements. They belong in an event log rather
than a sample series.

## Design

Two layers, and the existing stores are not replaced.

**Raw layer (new).** Append-only files, one directory per service occurrence, written
as the service runs. This is the source of truth for anything recomputed later.

**Derived layer (unchanged).** The existing JSON stores keep working exactly as they
do now, and stay what the UI reads. They become a cache of the raw layer rather than
the only copy.

Adding the raw layer beneath, rather than converting the stores, is deliberate:
`DataStore` already writes atomically (temp file + rename), so JSON on disk is not
less durable than CSV. The gap is *what is retained*, not how it is encoded — and
converting the working stores to CSV would cost a large migration, lose type
fidelity on nested shapes (per-metric maps, sample arrays), and buy no durability.

### Layout

```
<data>/archive/
  2026-07-26_st1-p123-t9/          one service occurrence (sanitised serviceKey)
    manifest.json                  schema version, serviceKey, counts, first/last sample
    spl.csv                        1 row per tick, 1 column per metric
    attendance.csv                 1 row per poll
    events.csv                     item changes, OBS/REAPER state, OSC feedback, automation fires
    baptisms.csv                   1 row per person
```

One directory per occurrence, not per day, so two services on a Sunday never share a
file — the same reason the recorders key on `serviceKey`.

### Format

**CSV, append-only, header written once on create.**

CSV is right *here* specifically, where it is wrong for the working stores: the rows
are flat, fixed-width and numeric, they are only ever appended, and a file truncated
by a power cut is still valid up to its last complete line. It also opens in Excel
with no tooling, which is half the point of the exercise.

One **wide** row per tick — all metrics on one line — not one row per metric per
tick. Same information, a quarter of the bytes, and it pivots directly.

Columns are discovered on first write and recorded in the manifest. A meter that
starts reporting a new metric mid-service gets a new file (`spl.2.csv`) rather than a
ragged one; the manifest lists both.

### Size

| | per service | per year (2×52) |
|---|---|---|
| SPL (1 Hz, ~10 metrics) | 0.41 MB | 43 MB |
| Attendance + events + baptisms | 0.04 MB | 4 MB |
| **Total** | **~0.45 MB** | **~47 MB** (~5 MB gzipped) |

Small enough that no retention policy is needed for years. A prune is out of scope;
if it is ever wanted it should be an explicit operator action, never automatic.

Adding wireless later roughly triples this, to ~1.4 MB/service and ~150 MB/year,
which is still small. Size is not the reason it is deferred.

### When recording happens

**Only while a service record is open** — the same gate the existing recorders use,
including the pre-service ramp and post-service taper. Nothing is written outside a
service.

Continuous capture is not wanted: samples taken on a Tuesday afternoon have no
service to belong to and nothing to be analysed against, and SPL alone would be
~7.8 MB/day (~2.8 GB/year) of it. Should that ever change it is the same writer with
a different gate, so nothing here forecloses it.

## Export

A **data archive**, distinct from the config snapshot: a zip of `archive/` plus the
derived history stores, with a top-level manifest listing schema version, app
version and the services inside.

It gets its own control, worded so the two are not mistaken for each other — the
config snapshot restores how the app is set up, the data archive restores what it
recorded, and importing the wrong one is not a mistake that announces itself.

It is separate on purpose. History is currently excluded from the config snapshot
with good reason — *"restoring them onto another install would fabricate services
that machine never ran."* That holds for cloning onto a different church's box. It
does **not** hold for rebuilding your own, which is the case this exists for.
Conflating the two would mean a config backup silently carrying a year of someone
else's services.

## Import, and the merge rules

The dangerous half. An import must never silently destroy what is already there.

1. **Match on `serviceKey`.** Present already → **skipped by default**, and reported
   as skipped. Importing the same archive twice changes nothing.
2. **Replacing is explicit**, per service, never a blanket overwrite.
3. **A service only in the archive is added**, raw files and derived record together.
4. **Raw and derived are imported as a pair.** A derived record whose raw files are
   missing is imported and flagged, since that is what every pre-archive service will
   look like — but never the reverse, which would leave the UI blind to data on disk.
5. **Schema version is checked first.** A newer archive than the app understands is
   refused with the version in the message, rather than half-read.
6. **Nothing is written until the whole archive has been read and validated**, so a
   corrupt zip cannot leave a half-imported year.

## Not retroactive

Nothing here recovers what has already been discarded. Services recorded before this
ships keep only their aggregates, and their Leq stays blank where it always was.
The raw layer starts the day it ships. Worth saying out loud in the UI too, or the
first person to export will expect a year of samples that was never captured.

## Testing

Pure and file-level, no network:

- The appender writes a header once, appends rows, and a file truncated mid-line is
  still parsed to its last complete row.
- A new metric appearing mid-service starts a new file rather than a ragged one.
- Round trip: record a synthetic service, export, import into an empty data dir,
  and the derived records match field for field.
- Import twice → the second is a no-op, and reports every service as skipped.
- Import with a service already present → skipped, not overwritten, unless replace
  is asked for that service.
- A newer schema version is refused, and nothing is written.
- A corrupt member in the zip aborts the whole import with nothing written.
- Sizes: a synthetic 75-minute service lands within the estimates above, so a
  regression in row width is visible.

## Out of scope

- **Wireless RF and battery.** Nothing depends on it today and it is two thirds of
  the bytes, so it waits. The writer is per-source and the layout already allows a
  `wireless.csv` alongside the others, so adding it later is a new caller rather than
  a change to anything here — but it does mean battery and RF history only starts
  whenever that happens, not now.
- Converting the existing stores to CSV. They stay JSON; see Design.
- Retention/pruning.
- Continuous (non-service) capture.
- Transcript archiving — large, and a different problem with its own privacy questions.
- Recomputing past services. There is nothing to recompute them from.
