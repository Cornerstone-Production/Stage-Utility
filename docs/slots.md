# Mic slots

A slot is one cell on the mic board. It links to a person, optionally binds a
wireless mic and an IEM pack, and shows a name, photo and live telemetry.

## Linking a slot to a person

A slot can be linked **by position**, **by person**, or given a **static** label.

### By position

A slot lists every position it will accept, and fills with the first one that has
someone available. Each entry can carry its own note filter, matched against the
team member's note in Planning Center.

| Positions listed | Fills with |
|---|---|
| `Vocals` (note starts "4") | the vocalist noted 4 |
| `Vocals` | whoever is on vocals |
| `Acoustic`, `Electric` | the acoustic player, else the electric player |
| note starts "IEM 3", no position | anyone noted "IEM 3", whatever their position |

Listing several positions is how one cell covers "the vocalist noted 4, or failing
that whoever is on acoustic". The note sits on each position rather than on the
slot, so the two can differ.

A position with a note never falls back to an arbitrary person in that position —
an unmatched slot stays empty rather than showing the wrong face.

Sub-variants group with their base: `Vocals (BGVs)` fills a slot asking for
`Vocals`.

### Slots that share people

**Slots listing an identical set of positions compete for the same people; slots
listing different sets do not.** Competing slots claim in board order, and each
person fills at most one of them.

Three slots all listing `Acoustic, Electric` with two guitarists scheduled: two
fill, the third stays empty. An empty range slot is a normal outcome.

A slot listing `Vocals→4, Acoustic` and another listing just `Acoustic` are
different sets, so both show the guitarist — which is what you want when someone
has two devices and needs to see both.

The editor flags any slot sharing its set with another, since adding one position
changes the grouping.

## Defaults and this week

Every service type has a **default** board — the lineup it comes back to every
week. A change made while a Planning Center plan is selected is saved against
**that plan only**, and the next plan of that type shows the default again.

The editor's pill picks which of the two you are editing:

| Side | What it is |
|---|---|
| **Default** | the service type's standing board |
| the plan's date | that plan's board. Carries an **edited** badge once it has one |

Two actions appear once a plan has a board of its own:

- **Revert to default** deletes that plan's board, so the screens go back to the
  service type's default.
- **Set as default** makes that plan's board the service type's default, and the
  plan stops being an exception.

Both discard something, so both ask first. Saving the default while a plan's own
board is in effect changes nothing on any screen — the plan's board still wins
until it is reverted or the plan advances.

Everything that writes slots lands on the side you are editing: a save, recalling
an arrangement, and copying slots from another view. A copy reads the source's
board for that same side and writes it to yours, and never deletes the board on
the other side. Copying onto the plan side from a view that has no board for the
plan copies that view's default into your plan's board, so your screen matches it
without your default changing.

A plan's board is deleted automatically once the plan is more than 30 days past.
Defaults are never pruned. When Planning Center cannot be reached to date a
plan, nothing of that service type is pruned.

Exporting a view carries the defaults for every service type. Per-plan boards do
not travel — a plan id means nothing on the far end.

### Switching plans in the editor

The slot editors carry a plan switcher — `‹ name ▾ ›` and a **Now** button — in
the slots view's header, in an inline grid's header, and in the layout editor's
toolbar while a mic-slots object is selected. It changes **which board you are
editing** and nothing else: what the screens follow is still set on the Plan page.

A badge says which you are looking at. **live** means the editor is on the plan
the screens are following; **editing** means it is on some other week or some
other service type, and a save there changes nothing on any screen until that
plan comes round. The save toast is the ordinary one while live and a quieter
one while not.

**Now** returns to the plan the screens are following, and the editor follows it
forward from then on — including when auto mode advances it mid-session.

Two modes, set on the Plan page:

| Mode | The middle | The arrows |
|---|---|---|
| **Within a type** | a dropdown of the active service types | that type's plans, Default first and then each upcoming date |
| **Upcoming plans** | the date and the type, e.g. "Wed Sep 10 · Cornerstone Youth" | every active type's plans in date order |

In **Upcoming plans** the middle's dropdown lists the next ten plans and a
**Defaults…** group with each active type's default board. The arrows do not
wrap: at either end of the list the arrow is simply disabled.

A board that is not on the list — a type's default while in **Upcoming plans**,
or a plan old enough to have dropped out of the window — sits immediately before
its own service type's first listed plan, so **›** from it lands on that type's
earliest listed plan rather than on the top of the week.

The list covers the last seven days and the next sixty, refreshed from Planning
Center at most every five minutes. When Planning Center cannot be reached the
switcher shows the plan the screens are following, disables the arrows and says
"Planning Center unreachable" — the board on screen is still editable.

Switching with unsaved slot edits asks first, the same question leaving the page
asks. A new tab, or a reload, always opens on the plan the screens are
following: where the switcher was pointed is never remembered.

### Presets

Slot presets are global and can be recalled onto any service type. Position names
are per-service-type, so a slot listing several positions travels better than one
naming a single position that another type does not define.

## Labels

`deviceLabel` and `iemLabel` are per-slot text. On a live device the mic label
replaces the frequency in the status strip and the IEM label renders beneath it;
RF bars and battery are unaffected. On an offline, manually assigned device the
labels are the whole pill.

The label's presence is the switch — blank shows the frequency, filled takes over.

The editor offers a **Use receiver name** button to fill the label from the
receiver's own channel name in one click.
