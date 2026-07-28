# Mic slots

A slot is one cell on the mic board. It links to a person (from Planning Center or
pinned by hand), optionally binds a wireless mic and an IEM pack, and renders a name,
photo and live telemetry.

## Linking a slot to a person

Three link kinds matter here: **by position**, **by person ID**, and **static**.

### By position — a range, not a single position

A slot lists every position it will accept. The first entry with someone available
fills it. Each entry carries its own optional **note** filter, matched against the
team member's note in PCO.

```ts
{ kind: "pco", matchBy: "position",
  positions: [{ name: "Vocals", notesStartsWith: "4" }, { name: "Acoustic" }] }
```

That reads: *the vocalist noted 4, or failing that whoever is on acoustic.* The note
has to sit on each position rather than on the slot, or "Vocals note 4, **or** Acoustic
with any note" cannot be expressed at all.

| `positions` | Fills with |
|---|---|
| `[{name:"Vocals", notesStartsWith:"4"}]` | the vocalist noted 4 |
| `[{name:"Vocals"}]` | whoever is on Vocals |
| `[{name:"Acoustic"},{name:"Electric"}]` | the acoustic player, else the electric player |
| `[{notesStartsWith:"IEM 3"}]` | anyone noted "IEM 3", in any position |
| `[]` | nothing — an unconfigured slot |

An entry with **no name** is the editor's "Any position" row: the note is the only
constraint. An entry with neither a name nor a note matches nobody, deliberately —
otherwise a half-configured slot would grab the first person on the team.

**Notes are required when set.** A position carrying a note never falls back to an
arbitrary person in that position. Without that rule, an unmatched "HH" slot would show
the "HS" pastor and look like the note was ignored.

**Sub-variants group with their base.** A trailing parenthetical is dropped when
matching, so `Vocals (BGVs)` fills a slot asking for `Vocals`.

### Slots that share people

> **Slots with an identical positions set compete; slots that differ do not.**

Identical means the same set of (position, note) pairs, order-insensitive. Competing
slots claim in board order and each person fills at most one of them. The editor shows
an inline note on any slot that shares its set with another, because ticking one extra
position silently changes the grouping otherwise.

This narrowness is the point:

- Three slots all listing `[Acoustic, Electric]` with two guitarists scheduled: two fill,
  the third stays empty. It cannot invent a third guitarist — an empty range slot is a
  normal outcome, not a fault.
- A slot listing `[Vocals→4, Acoustic]` and a separate slot listing `[Acoustic]` are
  **different** sets, so both show the guitarist. That is wanted: the player has two
  devices and needs to see which slot holds their pack.

Claiming is keyed by PCO person id where there is one, falling back to the team-member
row id, so someone scheduled in two positions still fills only one of a set of
identical slots.

### Presets across service types

Slot presets are global and `applyPreset` has no service-type gate, so recalling a preset
onto a different service type has always applied. It only *looked* broken because position
names are per-service-type and every slot silently no-matched. Listing several positions
fixes that without any preset-specific work.

## Labels on the cell

`deviceLabel` and `iemLabel` are per-slot text. On a **live** device the mic label takes
the frequency's place inside the status strip, and the IEM label renders on a second line
beneath it — RF bars and battery are untouched. On an **offline** (manually assigned)
device the labels are the whole pill, since there is no telemetry to show.

The label's presence is the toggle. Leave it blank and the frequency shows; type
something and it takes over. There is no separate switch.

**The receiver's own name is never applied automatically.** `listChannels` already uses
the receiver's `CHAN_NAME` as each channel's label, so the editor offers a "Use receiver
name" button that fills the label in one click. Applying it automatically would strip
frequencies off every cell of an already-named rack on upgrade.

## Files

- `main/types/stage.ts` — `SlotLink`, `SlotPositionMatch`, `Slot`, `SlotDevice`
- `main/services/slot-resolver.ts` — `resolveSlots()`, `positionSignature()`, `matchByPositions()`, `claimKey()`
- `main/services/slots-store.ts` — persistence + `migrateSlotLink()` (v2 single position → v3 range)
- `renderer/settings/sections/position-picker.tsx` — `PositionRangeEditor` (multi-select + per-position notes)
- `renderer/settings/sections/slots-section.tsx` — the slot editor, `makeSharesWith()`
- `renderer/components/slot-strip-mode.ts` — which pill a cell shows (strip / offline pill / nothing)
- `renderer/components/status-strip.tsx` — RF, label-or-frequency, IEM label, battery
