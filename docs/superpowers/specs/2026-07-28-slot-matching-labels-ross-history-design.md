# Slot matching, cell labels, Ross grouping, live Overview — design

**Status:** design approved in conversation; ready for an implementation plan.

Four independent changes, grouped because three of them were raised together. They
share no code and can ship as separate PRs in any order.

| # | Change | Where |
|---|--------|-------|
| A | Position ranges + per-position notes for slot matching | `slot-resolver.ts`, `slots-section.tsx`, `stage.ts` |
| B | Custom / RX-name labels on a slot cell in place of the frequency | `slot-panel.tsx`, `status-strip.tsx` |
| C | RossTalk + Ross MultiViewer TSL presented as one integration | integrations settings UI only |
| D | Overview trend + average include the running service | `service-history-section.tsx` |

---

## A — Slot matching by a range of positions

### The problem

A slot links to PCO by exactly one `teamPositionName` plus an optional note. The band
changes week to week, so a slot configured for "Acoustic" shows nothing on a week when
the guitarist plays electric — and the operator re-points slots by hand.

The same single-position link is also why recalling a slot preset onto a different
service type appears broken. `applyPreset` has **no** service-type gate and presets are
global, so the recall does apply; but position names are per-service-type, so every
slot silently no-matches and the board looks empty. Fixing the link shape fixes preset
recall as a side effect — no separate work.

### The shape

```ts
export type SlotLink =
  | { kind: "pco"; matchBy: "person"; personId: string }
  | { kind: "pco"; matchBy: "position";
      positions: Array<{ name?: string; notesStartsWith?: string }> }
  | { kind: "static"; label: string; color: string }
  | { kind: "empty" }
  | { kind: "spacer"; showEmptyImage?: boolean };
```

One list replaces `teamPositionName` + `notesStartsWith`. The note moves **onto each
position**, which a slot-level note cannot express: "Vocals note 4, or Acoustic with any
note" is a real configuration the operator wants.

An entry with **no `name`** means *any position* — the note is the only constraint. In the
editor this is an "Any position" row at the top of the checkbox list, with its own note
box. An entry with neither `name` nor `notesStartsWith` matches anyone unclaimed and
should be rejected by the editor as a misconfiguration rather than saved.

Five behaviours from one control:

| `positions` | Result |
|---|---|
| `[{name:"Vocals", notesStartsWith:"4"}]` | today's behaviour, unchanged |
| `[{name:"Vocals"}]` | whoever is on Vocals |
| `[{name:"Vocals",notesStartsWith:"4"},{name:"Acoustic"}]` | Vocals #4, else whoever is on Acoustic |
| `[{notesStartsWith:"IEM 3"}]` | note-only, position-agnostic |
| `[]` | nothing — an unconfigured slot, renders empty |

### Resolution order and contention

`resolveSlots` is a plain `.map()` today — each slot resolves independently and there is
no claiming at all. Two no-note slots on the same position both return `byPosition[0]`,
i.e. the same person. That latent duplicate has never surfaced only because every slot
in production carries a distinguishing note.

Ranges make contention reachable, so resolution gains one rule:

> **Slots with an identical `positions` set compete; slots that differ do not.**

Identical means the same set of `(name, notesStartsWith)` pairs, order-insensitive.
Competing slots claim in board order and each person fills at most one of them.

This is deliberately narrow, and it is what makes the operator's real case work:

- Slot 4 = `[Vocals→4, Acoustic]`, acoustic-pack slot = `[Acoustic]`. **Different sets**,
  so both show the guitarist — correct, because the player has two devices and needs to
  know which slot holds their pack.
- Three slots all = `[Acoustic, Electric]`. **Identical**, so two guitarists fill two
  slots and the third stays empty rather than triplicating one person.

**Known sharp edge:** adding one position to a slot silently changes whether it competes
with its neighbours. Mitigate in the editor — when a slot shares its exact set with
others, show "competes with slot N, M" inline. Do not leave this to be rediscovered.

A range slot with nobody left renders as an ordinary empty slot. Empty is a normal
outcome of a range, not a fault, and must not read as an error state.

### Matching within one slot

Positions are tried in configured order. For each entry: if it has a `name`, normalise it
with the existing `normalizePosition` (drops a trailing parenthetical, so `Vocals (BGVs)`
groups under `Vocals`) and filter the team to that position; if it has no `name`, the
candidate set is the whole team. Then apply that entry's note if it has one — preferring
an exact note match so `"1"` does not grab `"10"`, exactly as `slot-resolver.ts` does
today. First entry that yields an unclaimed person wins.

A position carrying a note requires a note match. It must never fall back to an arbitrary
person in that position; that is the bug the current code's comment warns about.

### Migration

`{ teamPositionName: "Vocals", notesStartsWith: "4" }` becomes
`{ positions: [{ name: "Vocals", notesStartsWith: "4" }] }`. The newly-created default
`teamPositionName: ""` (three call sites — `settings-view.tsx:719`,
`inline-slots-editor.tsx:80`, `slots-section.tsx:85`) becomes `positions: []`, an
unconfigured slot. A single-entry set is
identical only to another single-entry set with the same name and note, so an existing
board behaves exactly as it does today — including keeping its latent duplicates, which
the claiming rule now resolves in board order rather than duplicating.

Migration runs on load, in the same place other slot migrations run. `DataStore` does not
deep-merge on load, so the migration must be total: every `matchBy: "position"` link is
rewritten or the type no longer matches.

### UI

The position field becomes a multi-select of checkboxes, each ticked entry revealing a
small note box beside it. One control, no mode toggle, no second field — the multi-select
subsumes the "match by position vs match by note" distinction entirely.

---

## B — Custom and RX-name labels on the cell

### What already exists

More than expected. `Slot.deviceLabel` and `Slot.iemLabel` are already on the type and
already render — but only for offline/manual devices, via `OfflinePill`. And the receiver's
own channel name is **already being read**: every Shure provider sends `GET 0 ALL` at init
and parses `CHAN_NAME` into `DeviceStatus.name` (`shure-ulxd.ts:66`, and the same in
`shure-axient.ts` / `shure-psm.ts`). Nothing needs fetching. Only the render path for live
devices is missing.

### Precedence

**Manual label → frequency.** A typed label takes the frequency's inline position in the
status strip. The IEM label renders on a second line, present only when set, so a slot
without an IEM keeps a single-line strip.

```
┌──────────────────────┐
│      [ photo ]       │
│     Natalie L.       │
│       Vocals         │
│  ▂▄▆█  VOX 3   87%   │   label replaces 574.000 MHz
│        IEM 2         │   second line, only when set
└──────────────────────┘
```

The label's presence *is* the toggle — no checkbox. Empty label shows the frequency.

**The RX name never displays automatically.** It is offered as a per-slot "use the
receiver's name" action that fills the label box. Receivers in production already have
channel names programmed, so an automatic RX-name override would silently strip
frequencies off every cell on upgrade — the opposite of what the operator wants. Making it
an explicit action means nothing reaches a display that was not chosen.

RF bars and battery are untouched in all cases.

---

## C — One Ross integration

`rosstalk` and `ross-tsl` are genuinely different: one is a managed target list sending
commands over TCP 7788; the other is host + port with a feeds panel pushing people counts
to multiviewer tiles over TSL UMD. They frequently address the same Carbonite, which is
why two cards reads as clutter.

**This is a UI grouping, not a protocol merge.** One "Ross" card with a Commands section
and a MultiViewer section. Underneath, both keep their own descriptor id, enable flag,
config blob and connection state.

Collapsing them into a single id would require migrating `integrationEnabled` and
`integrationConfigs`, rewriting every layout RossTalk button and automation action that
references the id, and would leave one status badge trying to mean two connection states
at once. The grouping delivers the whole benefit at none of that cost.

---

## D — Overview includes the running service

### Root cause

Not a missing feature — a deliberate exclusion. `service-history-section.tsx:448`:

```js
const inScope = (typeId, date, ended) =>
  ended != null && (!activeType || typeId === activeType) && (!asOf || date <= asOf);
```

`ended != null` drops every record without an `endedAt`, which is exactly the service
currently recording. Line 334 states the intent outright: *"(The Overview stays
finished-only.)"*

Everything upstream is already correct and needs no change. `attendance-recorder.ts`
samples every 30s and broadcasts the open record every 5s (lines 21–23). The SSE channel
filter is dynamic, so `onNotification` self-registers. `service-history-section.tsx:312`
folds the live record into `attList` and refreshes the open detail. The day list already
renders it as "recording…". The filter at line 448 is the only thing standing between
that live state and the Overview.

### The change

Drop the `ended != null` guard so the running service enters the trend chart and the
stats, and render its point distinctly — it is a partial figure still climbing, not a
settled weekend total.

**One open decision.** "Avg attendance" is an average *across services*. Including a
service whose peak is still climbing pulls that average down early in the morning and it
will read as broken before it reads as live. Two defensible answers:

1. Include the running service everywhere. Literal reading of the request; the average
   dips at 9am and recovers.
2. Include it in the trend chart (as a live, visually distinct point) but compute the
   average over finished services only, showing today's number beside it rather than
   folded into it.

Recommend (2): it makes both surfaces move during the service, which is the actual
request, without a headline stat that looks wrong for the first half of the morning.
Confirm before implementing — it is a one-line difference.

### Testing

The filter is pure and testable without a live service: build `ServiceAttendance` fixtures
with and without `endedAt`, assert the running one reaches the trend series and that the
average matches whichever option is chosen. No network, no device I/O.

---

## Out of scope

- Merging RossTalk and TSL into one protocol or one integration id.
- Any change to how `attendance-recorder` samples, persists or broadcasts.
- Automatic RX-name display without an explicit per-slot action.
