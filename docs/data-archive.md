# Data archive

Every reading behind a recorded service is kept on disk, so a figure can be
recalculated later and a rebuilt machine can be given its history back.

## What it keeps

While a service is live, append-only CSVs are written under
`<data>/archive/<date>_<serviceKey>/`:

| File | One row per |
|---|---|
| `spl.csv` | 1 Hz reading, every metric on the row |
| `attendance.csv` | people-counter poll |
| `events.csv` | plan-item change, automation rule firing |
| `manifest.json` | — schema version and the files present |

Nothing is written outside a service.

Rows are only ever whole: each ends in a newline and the parser stops at the last
one, so a file cut short by a power loss reads back as every complete row it had.
If a meter starts reporting a new metric mid-service the writer moves to
`spl.2.csv` rather than leaving earlier rows misaligned.

About 0.45 MB per service, roughly 47 MB a year at two services a week. There is
no automatic pruning.

## Export and import

**Settings → Advanced → Data archive.** Download produces
`stage-archive-YYYY-MM-DD.zip` — the raw CSVs plus the recorded service records.

This is not the config snapshot. **Backup & restore** covers how the app is set up;
the **Data archive** covers what it recorded. They are separate files with separate
importers, and giving one to the other is refused by name.

Choosing a file inspects it and sorts every service into three groups: new, already
here and identical, and already here but recorded differently. Only the last needs a
decision, and it is one choice for the whole import:

| | |
|---|---|
| **Keep mine** (default) | leave every one of them as this machine recorded it |
| **Merge** | fill in what this machine is missing, change nothing it has |
| **Replace mine** | discard the local copy of each and take the archive's |

The choice applies only to services that actually differ, so the result matches the
count shown.

Merge is for one service recorded on two machines, neither with the whole thing. It
unions plan items, attendance samples and raw rows, keeping the local entry on any
clash, and recomputes attendance peaks over the filled gap.

Merge deliberately does not combine per-item sound levels where both sides recorded
the same item — those combine correctly only across disjoint time, and two machines
watching one service overlap almost entirely. The raw samples are merged, so the
figures can be recomputed properly.

Importing the same archive twice changes nothing. Every file is read and validated
before anything is written, so a corrupt archive cannot leave a half-imported year.

## Not retroactive

Services recorded before this shipped kept only their summaries. The raw layer
starts from the version that introduced it.

## Not included

- **Wireless RF and battery.** Sampled but not stored; the layout leaves room for it.
- **OBS, REAPER and OSC state.** The event log covers plan-item changes and
  automation firings.
- **Transcripts.** Large, with their own privacy questions.
