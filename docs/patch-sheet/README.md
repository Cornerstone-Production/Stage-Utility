# Patch sheet

A per-week stage patch reference: what source lands on which console input, where
each output feeds, and — the part volunteers actually need — what changed from the
standard this week.

Edit it with **Edit the patch** on the **Patch** page (`/patch/edit`). Volunteers read it at **`/patch`**, which
follows the live or next Planning Center plan on its own.

## Sheets

The patch is a set of sheets, each an independent surface of the same shape — the
way a console patch spreadsheet is usually organised: analog stage patch, Dante,
Waves SoundGrid, monitoring.

Each sheet has its own devices, endpoints, variants and weekly assignments. Sheets
can be colour-coded and marked with which team owns them.

## Devices

Each sheet's device list is the rack spine every endpoint references: racks,
snakes, drop snakes, floor pockets, wireless/RF and arrays. A device has a
**name**, a **color** that tints every channel sourced from it in the table and
on `/patch`, and can generate sequential connector labels from a **prefix**
(`B-`) and a starting number — those labels autocomplete in the From/To path
cells and ripple cleanly (`B-1` → `B-2`) in the patch table.

## Inputs and outputs

Both are first-class, on their own tabs.

**Inputs** — one row per rack input: console channel, source, mic or DI, 48V, and a
**From** path of ordered hops back to the stage box.

**Outputs** — one row per rack or console output: destination, feed type (IEM,
wedge, amp, stream, record), console channel, and a **To** path out.

Both are inline-editable and can be grouped **by device** or **by rack**. The
connection diagram is drawn from the path — there is nothing to wire by hand.

## Variants and the weekly patch

A **variant** is a named set of overrides on the default patch — a reusable
template or a specific event. Only the differences are stored, so re-wiring
infrastructure on the default flows through to every variant automatically.

What a given week resolves to, lowest priority first:

```
default  →  service-type standing variant  →  per-plan variant  →  week tweaks
```

Anything differing from the default is marked as changed, which is what drives the
volunteer highlight.

## The volunteer view

`/patch` is read-only and shows this week's resolved patch: the standard patch with
the week's variant and tweaks applied. It follows the live or next Planning Center plan
and updates without a reload. When a patch has more than one sheet with devices, a tab
per sheet sits across the top. An install with no patch yet shows "No patch has been set
up yet." with a link to the editor, which is also linked in the footer.

![The volunteer patch sheet: this week and what changed in a column beside a table per rack, each input with its signal path](../images/patch-sheet.png)

**At 1024px and wider** the page uses the whole width in two columns.

- **The left column** stays in view while the page scrolls. It holds *This week* (the
  service type, the plan and its date, the base variant and a Read-only tag), the amber
  **changes from the standard patch** card, and **Jump to**, a list of the racks showing,
  each with its colour and channel count. A change card row is the direction and channel
  (`in 11`, `out 8`), the source (struck through when unused) and a note: *was `<old
  label>`*, *new*, *re-patched* or *unused*. The card lists inputs and outputs together.
  Jump to scrolls to a rack and opens it if it was collapsed.
- **The right column** starts with the **Inputs / Outputs** switch, a **Filter** box, a
  **Changes only** toggle and, at the right, a legend showing how to read a signal path.
  Below it is one card per rack: a header with a chevron, the rack's colour, its name and
  its channel count (*8 of 24* while a filter hides some), then a table of channel,
  console channel, source (destination for outputs), mic (feed for outputs), 48V (inputs
  only), the signal path on one line, and a note.

Each row is one line. The colour of the first box a channel comes through shows as a
bar on the row's left edge. A channel that changed this week is tinted amber and its last
column says why; a channel marked unused is dimmed with its source struck through and
reads *unused this week*. A channel set under an owner has a group row, *Owned by
`<owner>`*, above its first row in the run. The header chevron collapses a rack.

Filter matches the channel number, source, mic, feed, console channel and owner. A
signal path reads source, the boxes it passes through, the rack and the console channel,
and outputs read the other way. The console end of the path is left out of a table row
when the card is too narrow to show the notes beside it, because the console channel has
a column of its own.

**Below 1024px** the page is one stacked column, which suits a phone in the wings: the
Read-only tag, This week, the legend, the changes card for the direction on screen, the
Inputs / Outputs switch with Filter and Changes only, then a collapsible card per rack
with two lines per channel, the same rules deciding which channels show.

## Bulk entry

Wiring a snake across a rack channel by channel is slow, so the editor has two aids.

**Ripple fill** (DiGiCo-style) — in **By rack** mode, arm the Ripple bar with how far
the fill reaches (2 to 12 channels, or to the end of the rack) and which columns
ripple. From and Console are on by default; Source, Mic and 48V are available for
inputs, To, Console, Dest and Feed for outputs.

**Connector labels** default to numeric and can be edited to whatever the rig uses
— `B-1`, `S11`, and so on.

**Import** accepts CSV and Excel with column mapping, for bringing in an existing
spreadsheet.

## Export and print

Three ways out, beside the Import button:

| | For |
|---|---|
| **Export CSV** | anything that reads a spreadsheet, and re-importing here |
| **Export Excel** | sending to someone — column widths set, header frozen |
| **Print** | the copy that gets taped to the rack |

The file always covers the **one sheet you are looking at**. If you are editing a
variant, that variant's patch is exported and its name is in the filename, so
`analog-stage-baptism-week-2026-08-03.csv` is not mistakable for the default a year
later.

Columns are `Rack ch`, `Console`, `Dir`, `Source / Name`, `Mic / Feed`, `48V`,
`Rack`, `Path`, `Owner`, `Notes`. **Path** carries the whole signal chain as
`Snake A:2 -> SD Rack:2`, which is the column an engineer actually traces; a direct
patch leaves it blank. A hop whose device has since been deleted shows the raw
device id rather than disappearing — losing a hop would misstate the path, and the
path is the point of the document.

Channels are written as text, so a leading zero survives: `01` stays `01`.
Endpoints marked unused are left out.

The headings are chosen so this app's own importer recognises every column without
hand-mapping, which makes the export a working backup as well as a document.

Export reads the **saved** sheet, so the buttons are disabled while you have
unsaved changes rather than quietly handing back an older patch.

Print hides the app around the table and prints black on white. The column header
repeats for each rack, and rack groups are kept off page boundaries. There is no
separate PDF export — print to PDF.

## Where it is stored

`patch.json` in the data directory, included in config backups.
