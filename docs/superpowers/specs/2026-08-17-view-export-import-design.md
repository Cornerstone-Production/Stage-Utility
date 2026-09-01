# Exporting and importing a view

**Goal.** Move a chosen view — usually a custom layout — from one Stage Utility
install to another as a file, without carrying the source building's whole
configuration with it.

**Mockup:** https://claude.ai/code/artifact/9e89333c-601b-49dd-ac0d-048e59b9d289

**Why.** A mobile deployment needs three layouts from the main install, not a
copy of the main install. The existing config snapshot is all-or-nothing: it
replaces `views.json` wholesale, along with every other config file. There is no
way to take one view.

## What a view drags behind it

A custom layout is not self-contained. Its objects reference about eighteen
kinds of thing outside the view, and the design turns on which of those travel.

**Travels, because it is meaningless left behind:**

| Thing | Where it lives | Keyed by |
|---|---|---|
| The view record and its layout | `views.json` | view id |
| Slot rows for an inline slots-grid | `slots.json` | layout object id |
| Notes and checklist content | `notes.json` | layout object id |
| A ScriptView layout | `scriptview-layouts.json` | `View.scriptViewLayoutId` |
| Image bytes | `layout-images/<sha256>.<ext>` | content hash |
| OSC and RossTalk target definitions | `osc-targets.json`, `rosstalk-targets.json` | target id |
| Views this one embeds | `views.json` | `view-embed.viewId`, `slots-grid.sourceViewId` |

**Stays behind:** wireless connections, integration configs, ProPresenter
instances, SenSource zones, Smaart meters and screens (outputs). A
`screen-embed.outputId` names a screen on the source install, so it travels as
rebind work (kind `output`) rather than as a carried reference.

The reason is that the destination has **different hardware**, not that these are
somehow less portable. A mobile deployment runs a duplicate set of gear — its own
ProPresenter machine, its own Smaart machine, its own wireless rack — so shipping
the source building's connection definitions would point the mobile rig at
receivers that are not in the room. That is worse than an unbound object, because
it looks configured.

An OSC or RossTalk target travels because it is an address the button owns and
the button is unreadable without it. A wireless connection is a different physical
receiver at the other end.

An object whose binding is not present keeps that binding and renders as
unconfigured. Nothing is silently stripped.

### What resolves anyway

Two kinds of reference survive the trip because their ids are not machine-specific:

- **Integration status** — `obs`, `reaper` and the rest are fixed constants, so
  the object works wherever that integration is configured.
- **The primary ProPresenter instance** — bindings are `"default"`, meaning
  whichever ProPresenter this server talks to. A different machine, the same id.

Everything device-level needs rebinding, because it names hardware:
wireless channels and charger bays (a `randomUUID()` connection id), Smaart
meters (`deviceName::channelName`), SenSource zones, and any extra ProPresenter
instance beyond the primary.

Smaart is the one worth a note in the docs: because its id is built from names
rather than a generated id, naming the mobile machine's device and channels to
match the building's makes those objects resolve on import with nothing to
rebind. The same trick cannot work for wireless.

## The file

One JSON document, reusing the config snapshot's envelope and its base64 image
map rather than inventing a second format.

```json
{
  "kind": "stage-utility-view",
  "version": 1,
  "appVersion": "1.11.0",
  "createdAt": "2026-08-17T14:12:00.000Z",
  "source": { "server": "Main Auditorium" },
  "views": [ /* the chosen view, then any it embeds */ ],
  "sideData": {
    "slots": { "<objectId|viewId>": { "<serviceTypeId>": [ /* rows */ ] } },
    "notes": { "<objectId>": { /* note or checklist */ } },
    "scriptviewLayouts": [ /* referenced layouts */ ]
  },
  "targets": {
    "osc": [ /* referenced target definitions */ ],
    "rosstalk": [ /* referenced target definitions */ ]
  },
  "images": { "layout-images/<sha256>.png": "<base64>" }
}
```

`source.server` is the exporting server's app name. It is shown on the import
screen and is never used to make a decision.

Downloads as `stage-utility-view-<slug>-YYYY-MM-DD.json`.

## Exporting

`Export layout` in a view's three-dot menu, beside `Duplicate view`. The same
item appears on a screen card and exports the view that screen shows.

Export walks the reference graph from the chosen view: an embedded view or a
sourced slots view is collected too, transitively, because a `view-embed` whose
target is missing renders an error rather than degrading. The result is
deduplicated by view id.

Slot rows are collected for **every** service type, not just the active one — the
destination may run different service types, and dropping the others silently
loses an operator's work.

Images are collected by walking every `image.src` in every collected layout and
reading the referenced file. A missing file is reported, not fatal: an export
that refuses because one logo was deleted is worse than one that says so.

## Importing

`Import layout…` beside the existing `New view` button on Screens, which also
accepts a dropped file. Views are created there, so an imported one arrives
where you would look for it.

The import is a merge into existing files, which is the substantive difference
from the config snapshot's whole-file replace. In order:

1. **Validate** `kind` and `version`. An unknown `kind` is rejected by name so
   the operator learns they picked the config snapshot by mistake.
2. **Mint fresh ids.** New view ids from `nextViewId()`; new object ids from
   `cloneLayoutWithMap`, which already returns the old→new map.
3. **Remap cross-references.** `view-embed.viewId` and `slots-grid.sourceViewId`
   are rewritten through the view id map. This is the genuinely new work:
   `layout-clone` shallow-copies `config`, so these currently survive a clone
   verbatim — correct when duplicating in place, wrong when several views arrive
   together and one embeds another.
4. **Re-key side data** through the object id map, the way `duplicateView`
   already copies slot rows and leaves notes behind.
5. **Write image bytes.** The image store is content-addressed by sha256, so
   re-importing a layout that shares a logo with one already here collapses to
   the same file rather than duplicating it.
6. **Merge targets.** A target whose id already exists locally is left alone and
   the imported object keeps pointing at it. A target that does not exist is
   added. An import never overwrites a local target definition.
7. **Name collisions.** An imported view whose name is taken arrives as
   `<name> (imported)`. The existing view is never touched.

### The report

Import returns what happened rather than a bare success, and the screen shows
it:

- views added, by name
- targets added, and targets already present that were left alone
- **bindings to rebind, grouped by kind and named individually** — not a count.
  Rebinding is the expected path, since the destination is a different rig, so
  this is a work list rather than a warning: "Handheld 3, Handheld 4 — need a
  wireless channel." Each entry links into the layout editor with that object
  selected.
- images that could not be written

Offering the rebind inline on this screen — a picker per entry — is the intended
follow-up. It needs one picker per binding kind, which is five small components
rather than one, and the grouped work list is useful without them.

A partial import is possible — a view can land while one of its images fails.
The caller is told which, and nothing is rolled back, because a layout missing
one image is more useful than no layout.

## Fixed on the way through

`duplicateView` (`main/services/stage-controller.ts`) omits `surface`,
`slotsLayout`, `scriptViewLayoutId` and `layoutRev` from the copy it builds, so
duplicating a console view silently produces a display. Export and import must
carry all four, and the duplicate path is the same few lines.

## Testing

The reference graph, the id remap and the merge rules are pure functions over
data and are tested as such. Beyond that:

- A view exported and re-imported **into the same install** produces a second
  view that renders identically and shares no ids with the first.
- A file containing three views where one embeds another imports with the embed
  pointing at the newly minted id, not the exported one.
- An import into an install lacking the referenced OSC target adds the target;
  an import into one that has it leaves the local definition unchanged.
- Slot rows and notes follow their objects, verified by reading them back
  through the store rather than by inspecting the bundle.
- A bundle naming an image that is not in `images` reports it and still imports
  the view.
- Driven against a real server, not only the helpers: the config snapshot's own
  history includes a restore that the next append deleted, with green tests over
  every piece.
