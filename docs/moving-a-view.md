# Moving a view between installs

Take one layout from one Stage Utility and put it on another — a mobile rig that
needs three layouts from the main install, not a copy of the main install. Or
take a whole service type's setup at once: see [Moving a plan](#moving-a-plan).

For everything at once, use the config snapshot in Settings → Advanced instead.
That replaces the destination's configuration; this adds to it.

## Doing it

**Export.** Three-dot menu on a view → **Export layout**. The same item is on a
screen card and exports whichever view that screen shows. One file downloads.

**Import.** **Import layout…** beside *New view* on the Screens page, or drop the
file on that button. You get a review of what is in the file before anything is
written, then a report of what landed.

Imported views are **added**, never merged into existing ones. A view whose name
is taken arrives as `<name> (imported)`; the one you already had is untouched.

## Moving a plan

A **plan export** is one service type's whole setup rather than one layout: every
slot board that type has, the views and layouts holding them, and — by choice —
the patch sheet variant it is assigned to and your saved slot presets. It is per
service type, never per date: a per-plan board is one week's exception keyed by a
Planning Center plan id, and that id means nothing on another machine.

**Export.** Settings → Plan → **Export plan…**, beside *Active Service Types*.
Pick the type and tick what travels:

| | |
|---|---|
| Views and layouts | Always. Every view with a board for this type, plus anything they embed |
| Mic slots | *This type only*, or *every type on those views* — the second is for a destination that runs other types on the same layouts |
| Patch sheet variant | The variant this type is assigned to, per sheet. Off when no sheet assigns one |
| Slot presets | Off by default. They are global, not this type's |
| ScriptView layouts | Always. The column presets those views use |

The counts beside each row come from the export itself, so what the dialog says
and what the file holds cannot disagree. A service type with no board anywhere
cannot be exported — there would be nothing in the file.

**Import.** The same **Import layout…** button. A plan file is recognised by the
service type on it, and the review adds two decisions:

- **Import as service type.** Which type on *this* machine the boards and the
  patch assignment land under. It starts on the id the file names when this
  machine has it, and on the type this machine is currently running when it does
  not. At *every type on those views* scope, only the exported type's board is
  re-keyed; the others land under their own ids.
- **Keep mine where they clash** / **Replace mine.** Keep is the default.

**Only the patch assignment and the presets can clash.** Imported views always
arrive as new views with new ids, so their slot rows are always new boards — they
never land on top of anything you have.

### What the patch section does and does not carry

The **variant** only: a named overlay of endpoint overrides, plus the fact that
this service type uses it. The rig — devices, endpoints, the default patch —
stays behind, for the same reason wireless connections do. A variant is an
overlay on top of whatever the destination's own patch already says.

The sheet is matched by id and then by name, so a destination that built its own
*Analog* sheet still resolves. No match is reported in the import report and is
not fatal: the views and boards are already in by then.

Under **Keep**, a sheet where this type already points at a different variant is
left completely alone — the variant is not even added, because a variant nothing
points at is clutter in the patch editor rather than a useful spare.

Under **Replace** the file's variant lands and the assignment moves onto it. The
import report names the variant the type used before, so an assignment taken off
one of yours is never silent.

## What comes with it

| | |
|---|---|
| The layout, and any view it embeds | An embed whose target is missing renders an error, so dependencies come automatically |
| Slot rows | Every service type, not just the active one |
| Notes and checklists | Keyed to their objects, so they follow them |
| Images | Stored by content hash, so a logo you already have is shared, not duplicated |
| OSC and RossTalk targets | Definition only. A target you already have with the same id is kept as yours |

## What does not, and why

Wireless connections, integration configs, ProPresenter instances, SenSource
zones and Smaart meters stay behind.

Not because they are secret — passwords never leave the machine they were
entered on — but because **the destination has different hardware**. A mobile
deployment runs its own ProPresenter machine, its own Smaart machine and its own
wireless rack, so bringing the source building's connection definitions would
point the new rig at receivers that are not in the room. That is worse than an
unbound object, because it looks configured.

The target of an **Embedded screen** object stays behind for the same kind of
reason: it watches an output id, and an output is a screen configured on this
install. The file carries no outputs at all, so every screen tile in an
imported wall arrives unbound, whatever it was pointed at on the source.

Objects bound to absent gear or a missing screen **keep their bindings** and
render as unconfigured. Nothing is silently cleared. The import report lists
them by name, grouped by what they need, and each entry opens the editor for
the view holding it.

### What resolves anyway

Two kinds of reference survive the trip with nothing to do:

- **Integration status** — `obs`, `reaper` and the rest are fixed names, so the
  object works wherever that integration is configured.
- **The primary ProPresenter instance** — bindings say `default`, meaning
  whichever ProPresenter this server talks to.

**A trick worth knowing:** an SPL meter is identified by
`<device name>::<channel name>`. Name the mobile Smaart machine's device and
channels the same as the main one and those objects resolve on import with
nothing to rebind. This does not work for wireless, whose ids are generated
rather than named.

## The file

Plain JSON, `kind: "stage-utility-view"`. Importing a config snapshot by mistake
is refused by name rather than with a generic error, and the reverse is true
too.

It contains no credentials. Passwords live in the encrypted secrets store, which
nothing in an export reads.

## API

| | | |
|---|---|---|
| GET | `/api/views/:id/export` | The view and its dependencies as one file |
| GET | `/api/plans/export` | One service type's setup as one file (`?serviceTypeId=&slots=type\|all&patch=1\|0&presets=1\|0`) |
| GET | `/api/plans/export/preview` | What that file would contain, for the dialog's counts (`?serviceTypeId=&slots=type\|all`) |
| POST | `/api/views/import` | Merge a bundle in; returns what landed and what needs rebinding. `{bundle, serviceTypeId?, onClash?}` to land a plan under a chosen type |
