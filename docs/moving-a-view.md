# Moving a view between installs

Take one layout from one Stage Utility and put it on another — a mobile rig that
needs three layouts from the main install, not a copy of the main install.

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

## What comes with it

| | |
|---|---|
| The layout, and any view it embeds with an **Embedded view** object | An embed whose target is missing renders an error, so dependencies come automatically |
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
| POST | `/api/views/import` | Merge a bundle in; returns what landed and what needs rebinding |
