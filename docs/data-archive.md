# Data archive

Every reading behind a recorded service is kept on disk, so a figure can be
recalculated later and a rebuilt machine can be given its history back.

## What it keeps

While a service is live, append-only CSVs are written under
`<data>/archive/<date>_<serviceKey>/`:

| File | One row per | Columns |
|---|---|---|
| `spl.csv` | 1 Hz reading, every metric on the row | `at`, `itemId`, `item`, then one per metric |
| `attendance.csv` | people-counter poll | `at`, then one per counter field |
| `events.csv` | plan-item change, automation rule firing | `at`, `source`, `kind`, `detail`, `itemId`, `plannedLengthSec`, `preService` |
| `baptism.csv` | press on the baptism timer | `at`, `event`, `mode`, `phase`, `personNumber`, `baptismIndex`, `segmentMs`, `itemId`, `item`, `detail` |
| `manifest.json` | — schema version and the files present | — |

An event row's last three columns describe the plan item on a `kind=item` row and
are empty on every other kind. They are what lets a service's timing record be
rebuilt from the raw rows rather than only from the title: a title is not an
identity, and a planned length appears nowhere else in the raw layer. Rows written
before those columns shipped keep their narrower file and still read back — the
rebuild matches them to the stored record by title instead.

A baptism row is one press, never a total: Start, each testimony ending, the
baptisms arming, the first person stepping up, each person baptized, pause,
resume, Undo, Finish and Reset. The
finished session in `baptism.json` is derived from them, so a session lost to a
corrupt file, or to a crash between the debounced save and the next write, is
derivable from the presses instead of being gone; see
[Rebuild from raw](#rebuild-from-raw). `undo` is recorded as its own
row rather than the row it cancels being removed — the file is append-only, so
what was undone is still in it and only that marker says so. An operator pressing
Undo does not lose a service; a file that lost the marker would count the mis-tap.
Because every row carries its `at`, the rows also place each testimony and baptism
in real time, which the durations in `baptism.json` cannot: a service's session
lane is derived from them (`GET /api/baptism/lane`, see
[API](reference/api.md)).

Nothing is written outside a service.

Rows are only ever whole: each ends in a newline and the parser stops at the last
one, so a file cut short by a power loss reads back as every complete row it had.
If a meter starts reporting a new metric mid-service the writer moves to
`spl.2.csv` rather than leaving earlier rows misaligned.

About 0.45 MB per service, roughly 47 MB a year at two services a week. There is
no automatic pruning.

## Export and import

**Settings → Advanced → Data → Data archive.** Download produces
`stage-archive-YYYY-MM-DD.zip` — the raw CSVs plus the recorded service records.

This is not the config snapshot. **Config snapshots** covers how the app is set up;
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

## Editing a recording in History

Correcting a recording — trimming its window, recalculating attendance, merging
two same-day recordings, deleting one — is a different operation from importing
an archive, and it treats the raw layer differently in each direction:

- **Merging two recordings moves the raw rows.** The source's CSVs are rewritten
  into the target's directory, chronologically and widened to the union of both
  column sets, and the source directory is removed. Not optional: SPL rebuilds
  its record from these rows after a restart, so a merge that left them behind
  reverted itself the next time the box came up.
- **Deleting a recording keeps the raw rows.** Their loss cannot be undone, and
  nothing reads them for a service with no record. Removing an operator's raw
  samples is a bigger decision than "delete this recording" asks for; the
  directory is named `YYYY-MM-DD_serviceKey` if you want to remove it by hand.
- **Correcting one item's times never touches the raw rows.** An item's start
  and end are an observation the raw `events.csv` also holds, so a correction is
  stored beside the items as an overlay (`itemTimeEdits`) and applied on every
  read. Rebuilding the record from `events.csv` re-derives the raw run and the
  correction goes straight back on top, so a rebuild cannot undo an edit. Reset
  removes the overlay and the row reads what the recorder saw.
- **A corrected item does not move its neighbours.** Shortening an item leaves a
  gap before the next one, and the table shows the gap. Closing it would invent
  timings for items nobody asked about.
- **Trimming the window trims the corrections with it.** A correction is pulled
  back to the new start or end the same way the items around it are; one that the
  trim leaves with no run, or with no time left to describe, is dropped and named
  in the log.
- **A service that is recording right now cannot be edited at all.** The
  recorder holds the same record, so any change races its next write. History
  refuses until the service ends.

### Rebuild from raw

**Edit times → Rebuild from raw** throws the stored summaries away and derives
them again from the rows underneath, each from its own file:

| Record | Derived from | How |
|---|---|---|
| Item timings | `events.csv` | Every `kind=item` row in time order. An item going live again within ten minutes of its last entry closing is the operator stepping back and reopens that entry; anything later is a re-run with its own. Each entry ends when the next row fires, the last at the recording's end |
| Sound levels | `spl.csv` | The same fold the recorder does live — per-item max, Leq and sample count |
| Attendance | the record's own samples | Peak, lowest and last re-derived, as **Recalculate** does |
| Baptism sessions | `baptism.csv` | See [Baptisms are merged, never replaced](#baptisms-are-merged-never-replaced) — unlike the other three, this leg never removes a session at all, not even at the MAX_SESSIONS cap: a new session the store has no room for is simply not added, not evicted for |

It reports what it **derived** and, separately, what it left alone: a record the
raw layer holds nothing for is untouched and said to be untouched, rather than
reported with the count it already had. A recording with no raw rows at all is
refused, as is one whose service is still recording.

What survives: the recording's identity and window, the pacing reset, the
per-item include/exclude overrides, and the per-item time corrections — those
are an overlay over the rebuilt run rather than a change to it, so the rebuild
re-derives the raw timings and the correction goes straight back on top.

A correction follows its RUN, not its row number. The rebuild pairs the nth run
of an item to the nth run, the same way it carries the recorder's own
include/exclude observation, so a rebuild that finds items the stored record
never had moves every correction along with the run it was made about rather
than leaving it on whichever row inherited its number. A correction whose run the
rebuild no longer produces at all is dropped, and the [history] log names it.

Rows written before the item id and planned length were archived carry only a
title. Those are matched to the stored record by title; a title the record never
held gets an id derived from the title, and the log says which.

### Baptisms are merged, never replaced

The other three legs above replace what they hold; baptism sessions do not,
because `baptism.json` can hold a session the rows never could: one split
across a mid-session `serviceKey` roll (its start and finish land in two
different archive directories, so no single replay produces it), one recorded
before the raw layer existed, or one whose rows were lost outright. Replacing
a service's whole set of sessions with what the rebuild reconstructs would
delete every one of those.

So the rebuild merges instead. Each rebuilt session is matched against EVERY
stored session first by `id`, decided for the whole batch before any session
falls back to the next rule, then against the nearest still-unmatched stored
session within two seconds of its `startedAt` — nearest across every
candidate pair at once, not merely the first one tried, for one recorded
before the timer threaded its own stamp straight through to the row (older
sessions can be off by about a millisecond).

A match keeps the stored session's own id, start time and labels no matter
what; what happens to its people and finish time depends on how the two
compare:

| Rebuilt finish vs. stored | People match | Result |
|---|---|---|
| later by more than 100ms | — | **Updated** — a genuinely later Finish the store never saved (a re-Finish that DID reach the row, because the service was still open, but whose own save to `baptism.json` failed at the time) |
| within 100ms (the same Finish) | yes | **Unchanged** — reproduced exactly; nothing written |
| within 100ms (the same Finish) | no | **Disagreeing** — the store is authoritative for the same Finish, so it is left exactly as it is, and the disagreement is logged: it can only mean a lost row or a replay defect |
| earlier by more than 100ms | — | **Newer** — the store's own correction is newer than what these rows can show (presses made after the service closed, or a serviceKey roll — an Undo and a longer re-Finish that never reached that service's rows again); a rebuild must never revert it |
| either side's finish time will not parse | — | **Left as stored** either way, logged: there is no reliable answer to compare against |

100ms separates real clock skew (at most a few milliseconds) from a human
undoing a Finish and pressing it again, which takes far longer. An unmatched
session with a readable finish time is **added** — unless the store already
holds MAX_SESSIONS sessions, in which case adding it would mean evicting
something else to make room, which a rebuild never does; it is counted as
**full** instead, and logged, exactly as if a rebuild found no unmatched
sessions to add at all. One whose finish time will not parse is discarded,
not added, and logged. A stored session with no rebuilt counterpart at all
is **kept**, left exactly as it is — an update to a DIFFERENT session can
never displace it, at the cap or otherwise; see
[Rebuild from raw](#rebuild-from-raw) above.

Three surfaces report this, at three different levels of detail. The
`[baptism]` log line names `updated` and `added` as running counts, then
`unchanged`, `newer`, `disagreeing` and `kept` as running counts too (zero
included), `invalid` only when it is not zero, and `full` only when it is
not zero, in a line of its own naming the cap and how many sessions could
not be added. The Baptisms tab's own result names every category except
`unchanged`, since a session the rows reproduced exactly needed nothing said
about it — `updated` and `added` always shown, the rest (including `full`)
only when they are not zero. History's result names the same categories the
Baptisms tab does, but folds them into "what was written" (`added`,
`updated`, shown only when nonzero), a "left alone" breakdown (`newer`,
`disagreeing`, `invalid`, `kept`, each shown only when nonzero), and `full`
as its own clause when nonzero, since its one line already covers three
other legs.

Reachable from three places, all of which post the same merge: the Baptisms
tab's own **Rebuild from raw**, in its header, targets one service on its own
(`POST /api/baptism/rebuild`); a save-failure entry's own **Rebuild from raw**,
in the Timer card's note, targets that entry's own service the same way;
History's **Rebuild from raw** runs the same merge as one more leg alongside
timings, sound and attendance. A session the merge **adds or updates** that
also names a save-failure entry's own id clears that entry on the server,
whichever of the three routes did the restoring — added covers the ordinary
case (Finish's own failure left no copy in the store at all); updated covers
a LATER re-Finish that failed, where the store already holds that session's
earlier, now-stale Finish and the rebuild brings it up to date instead of
adding a second copy. A session merely left as it was — unchanged, newer in
the store, or disagreeing with the rows — never clears the entry, since
nothing about the stored record changed; nor does one the rebuild could not
restore (an unreadable finish time, or a store already full). See
[Recovery](features/scriptview-and-baptisms.md#recovery) for what the note
itself shows.

### Raw in the bundle, effective in the workbook

The archive bundle exports the **raw** records plus their overlays, so an import
restores both the recording and the corrections with Reset still working. The
History workbook (`GET /api/history/export`) exports the **effective** times, so
the spreadsheet and the History panel agree.

## Not retroactive

Services recorded before this shipped kept only their summaries. The raw layer
starts from the version that introduced it.

## Not included

- **Wireless RF and battery.** Sampled but not stored; the layout leaves room for it.
- **OBS, REAPER and OSC state.** The event log covers plan-item changes and
  automation firings.
- **Transcripts.** Large, with their own privacy questions.
