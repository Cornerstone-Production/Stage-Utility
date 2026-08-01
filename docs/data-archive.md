# Data archive

What the app has recorded, kept and portable.

## Why it exists

The SPL recorder samples every second while a service is live and folds each reading
straight into `max`/`leq`/`count`. The sample is then discarded.

When the average was corrected from an arithmetic mean of decibels to an energy
average, every past service was stuck with the wrong figure. The maths was
recoverable; the data was not. Nothing about that was specific to SPL — it is what
happens whenever the only thing kept is the answer.

## What it holds

While a service is live the app writes append-only CSVs under
`<data>/archive/<date>_<serviceKey>/`:

| File | One row per |
|---|---|
| `spl.csv` | 1 Hz tick — every metric on the row |
| `attendance.csv` | SenSource reading (every poll, not the 30s trend points) |
| `events.csv` | plan-item change, automation fire |
| `manifest.json` | — schema version and the files present |

Rows are only ever whole: each line ends in a newline and the parser stops at the
last one, so a file cut off by a power loss reads back as every complete row it had.
If a meter starts reporting a new metric mid-service the column set changes and the
writer moves to `spl.2.csv` rather than leaving earlier rows misaligned; the manifest
lists both.

Nothing is written outside a service. No open service record means no `serviceKey`,
and no key means every archive call is a no-op.

## Export and import

**Settings → Advanced → Data archive.** Download produces
`stage-archive-YYYY-MM-DD.zip` — the raw CSVs plus the derived history stores.

This is not the config snapshot. **Backup & restore** covers how the app is set up;
the **Data archive** covers what it recorded. They are separate files with separate
importers, and handing one to the other is refused by name.

Choosing a file inspects it and sorts every service into three buckets: **new**,
**already here and identical**, and **already here but recorded differently**. Only
the last needs a decision, and it is **one choice for the whole import** — a control
per service is unreadable once a year's worth disagrees:

| Choice | What it does |
|---|---|
| **Keep mine** (default) | Leaves every one of them exactly as this machine recorded it. |
| **Merge** | Fills what this machine is missing — plan items, attendance samples and raw CSV rows it never recorded — and changes nothing it already has. |
| **Replace mine** | Discards the local copy of each and takes the archive's. |

The choice applies only to services that actually differ. Ones already here and
identical are left alone, so the result always matches the count the panel showed.

Attendance peaks are recomputed after a merge, since a peak measured over a gap is
wrong once the gap is filled — but only in-service samples count toward it. The
recorder deliberately excludes the pre-service ramp and post-service taper from
peaks, and merging respects that.

Merge exists for one service recorded on two machines, neither with the whole
thing: a box that restarted at 09:20 is missing twenty minutes another box has.
Replacing would trade one gap for another; keeping leaves the gap.

**What merge deliberately does not do** is combine the per-item SPL aggregates when
both sides recorded the same item. `max`/`leq`/`count` can be combined exactly, but
only if the two recordings cover disjoint seconds — and two boxes watching the same
live service overlap almost entirely, so combining would count the same sound twice.
Where both sides have an item, the local figures stand. The raw CSVs *are* merged by
timestamp, so the samples needed to recompute it properly are retained.

Other rules:

- Importing the same archive twice changes nothing; merging twice changes nothing.
- `Replace` wins if a service somehow ends up in both lists.
- Every member is parsed before anything is written, so a corrupt file cannot leave
  a half-imported year.
- A derived record whose raw files are missing still imports — that is what every
  pre-archive service looks like.
- Baptism sessions dedupe on their id, since one service can hold several.

Choosing a file only inspects it and states what would happen — how many services
are new, how many are already here. The Import button appears after, and not at all
when there is nothing to add.

## Not retroactive

Services recorded before this shipped kept only their aggregates. The raw layer
starts from the version that introduced it; nothing here recovers what was already
discarded.

## Size

About 0.45 MB per service, roughly 47 MB a year at two services a week. There is no
automatic pruning — deleting anything is an explicit operator action.

## Not included

- **Wireless RF and battery.** Sampled at 1 Hz and still not stored. Nothing depends
  on it yet and it is two thirds of the bytes, so it waits; the layout leaves room
  for a `wireless.csv` beside the others.
- **OBS, REAPER and OSC state.** They have no single change-detection chokepoint
  today, so the event log covers plan-item changes and automation fires only.
- **The ProdCom transcript.** Large, and a different problem with its own privacy
  questions.
