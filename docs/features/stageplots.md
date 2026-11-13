# StagePlots

Stage diagrams for every room a team plays in and every place it visits. A
volunteer opens `/stageplots` on a phone at load-in and sees the room's plot; the
desk edits them at `/stageplots/edit`.

## Venues and plots

A **venue** is a room (**Home**) or a place you visit (**Offsite**). The kind only
groups the list: home venues first. Each venue has a name, notes (load-in, where
the floor pockets are) and up to 20 **plots**.

A plot is a drawing of the venue for one kind of service: a name, a background,
and how far the background is faded toward the paper. One plot per venue is its
**default**, marked with a star in the editor and *Default* on `/stageplots`. A
venue's first plot becomes its default. The default cannot be deleted until
another plot is made the default; deleting a venue deletes its plots.

A plot is 1000 units wide, and its height follows its background's shape. A plot
with no background is drawn on a plain 16:9 grid.

## Backgrounds

A background is a drawing, a photo or a page of a PDF, uploaded once and shared by
any plot in any venue.

| Upload | Up to | What happens |
|---|---|---|
| PNG or JPEG | 12 MB, 50 megapixels | converted on the server |
| PDF | 25 MB | the browser shows the pages and you choose one; the PDF is kept on the server and that page is converted |

The page of a PDF is chosen when it is uploaded. To use another page, upload the
PDF again. Anything that is not a PNG, JPEG or PDF by its contents (an SVG, HEIC,
GIF, WebP or a renamed file) is refused before anything decodes it.

**Conversion.** Once, when a background is uploaded or its clean-up is switched:
turned the right way up from the photo's orientation tag, brought down to 2400
pixels on its long edge (never enlarged), and saved as a WebP under 1 MB, stepping
the quality down from 80 to 40 until it fits. An image that does not fit even then
is kept and the log says so.

**The source.** What a background keeps to convert from again is the upload (or the
rendered PDF page) turned the right way up and brought down to 2400 pixels on its
long edge, never enlarged, in its own format (a JPEG at quality 90, a PNG at full
compression), with every piece of metadata dropped: the camera, the location a
phone records, and any colour profile, the pixels converted to sRGB. A photo's
source is typically 1 to 3 MB; for a PNG or JPEG upload it is also what the detail
calls the original. An uploaded PDF is kept as it was.

**Clean-up** turns the background into a quiet drawing for items to sit on:
greyscale, contrast evened out, then faded 40% toward white. It is on for a new
upload. Switching it converts again from the kept source, so it can be switched
back. The background's detail shows the source and the result side by side, the
original's size, the web image's size and pixels, and which plots use it.

A background that a plot uses cannot be deleted; the refusal names the plots.
A file no background names any more (a deleted background, the image a clean-up
switch replaced, a PDF whose page never arrived) is removed once it is an hour old:
straight after a delete or a clean-up switch when it already is, and otherwise by
the daily tidy. The hour keeps a PDF upload's original safe between its two
requests. At most five PDFs may wait for their page at once; a sixth is refused
until one is finished or an hour has passed. A PDF written more than an hour ago
never counts toward the five.

The tidy deletes nothing once the server has found `stageplots.json` damaged, nor
while the damaged copy sits beside the store as `stageplots.json.corrupt-<time>`:
the store starts empty after one, and that copy is what names the files. Each
skipped run says so in the log. Restore from the copy, then move it out of the
data folder, and the tidy resumes.

A clean-up switch on a background whose source file has gone from the server is
refused; upload it again.

On the server a background is up to three files, each named by a hash of its
contents:

| Folder | Holds | Served |
|---|---|---|
| `stageplot-images/` | the converted WebP, and the 2400-pixel PNG or JPEG source it was converted from | yes, cached forever |
| `stageplot-originals/` | an uploaded PDF | never |

Converting runs one image at a time, so a Raspberry Pi converting a 12-megapixel
photo does not hold two in memory.

## /stageplots

Read-only. The venues as cards, home then offsite, each with a thumbnail of the
plot it shows this week and a line saying which: "3 plots · Baptism for this
plan" or "1 plot · Default". A venue opens to its plots as tabs with that plot
selected, the plot itself, its legend, and the venue's notes.

The page follows the live or next Planning Center plan, the plan
[/patch](../patch-sheet/README.md) follows. A venue shows that plan's override if it has
one (see [Default and this week](#default-and-this-week)), labelled **For this
plan · Sun 15 Nov**, and otherwise its default plot, labelled **Default**. When
the stage moves on to the next plan, every open page follows without a reload;
a tab picked by hand gives way to the new plan's plot. The date is the plan's,
in the [app time zone](../ops/install-and-config.md#time-zone).

- With no plan live or coming up, or Planning Center not connected, each venue
  shows its default and no notice.
- When Planning Center cannot be read, each venue shows its default under
  "Planning Center is unreachable, showing the default plot." The page asks
  every minute while it is open; one failed answer after a good one changes
  nothing, two in a row put up the notice, and the next good one takes it down.

- With exactly one home venue, `/stageplots` opens it directly.
- The browser remembers the last venue opened and opens it next time; **Stage
  plots** above the venue's name goes back to the list and forgets it.
- Pinch or Ctrl/Cmd-scroll to zoom, drag to pan, and the buttons in the plot's
  corner zoom in, out and back to the whole plot. An ordinary scroll pans only
  once the plot is zoomed in, so the page still scrolls past it.
- Tap an item for its label, kind, notes and numbered inputs: beside the item on a
  desk, as a sheet along the bottom on a phone. A tap on the empty plot, anywhere
  off the plot, or Escape closes it; text has no details.
- **Print** beside the venue's name prints the plot (see [Printing](#printing)).
- A saved edit anywhere shows without a reload.

**Edit** in the bar opens the editor.

## /stageplots/edit

Venues and Backgrounds down the left, the selected venue's plots on the right.
Venues, backgrounds, plots and a plot's background and fade save as they are made,
and every open `/stageplots` follows them. A change the server refuses says why
beside the control, and the page goes back to what is saved. What is drawn on a
plot is a draft until **Save** (see [Editing a plot](#editing-a-plot)).

- **Venues**: **+ Venue** adds one and selects it. The selected venue's name and
  notes save when you leave the field; Home or Offsite saves at once.
- **Backgrounds**: **Upload**, the list, and the selected background's detail with
  its **Clean-up** switch and **Delete background…**.
- **This week**: which plot the selected venue shows for the live or next plan,
  and for other upcoming plans (see [Default and this week](#default-and-this-week)).
- **Plots**: a tab per plot, **+** for a new one (it starts on the selected plot's
  background), and **⋯** on the selected tab for **Rename**, **Duplicate** (an
  independent copy named "… copy", which opens), **Set as default** and
  **Delete…**.
- **Toolbar**: undo and redo, zoom, the plot's **Background** (or **None (grid)**),
  **Fade**, which previews on the plot while dragged and saves when let go, and
  **Print**.

A plot switched to a background that makes it shorter moves any item that no
longer fits wholly on it up until it does, and brings a cable's points below the
new edge up to it. That changes the plot's items: switching back does not
put them where they were. The log says how many moved. With unsaved changes on the
plot, picking another background asks first: **Save and switch**, **Discard and
switch**, or **Cancel**; it never switches under unsaved work.

### Default and this week

Each venue has a default plot, the starred tab, set from a plot's **⋯** with
**Set as default**. Any Planning Center plan can show a different plot in that
venue instead, for that plan only; [/stageplots](#stageplots) shows it while
that plan is live or next, then goes back to the default. The patch sheet's
standing per-service-type layer has no equivalent here: a plan's plot is the
default unless that plan says otherwise.

The **This week** card, for the selected venue:

- **Plan · Sun 15 Nov** and a list: **Default (Standard)** or another of the
  venue's plots, for the live or next plan (the plan `/stageplots` and
  `/patch` follow). It saves when chosen.
- **Upcoming plans with an override**: each later plan given a plot, by date,
  with **×** to hand it back to the default.
- **Another plan…** lists the upcoming plans the slot editor's plan switcher
  lists (the next two months, every service type the Plan tab enables); pick
  one, then its plot.

With Planning Center not connected the card says so and offers no plan.

Deleting a plot that plans use hands those plans back to the default, and the
confirm names them first. Deleting a venue takes its plans' overrides with it.
An override for a plan that has happened is kept, as a record of what the
room looked like; it no longer shows in the list.

### Editing a plot

Under the toolbar: the palette, the plot, its legend, and the inspector for the
selected item.

- **Add**: press an item in the palette. It lands in the middle of what the plot
  shows, selected, each one a little further down and right than the last. When the
  palette with its names would leave the plot under 600 pixels wide, it shows icons
  only, each named by its tooltip.
- **Select**: press an item. Press the empty plot to clear the selection; dragging
  the empty plot pans it.
- **Move**: drag the item. **Resize**: drag the square at its corner; it grows
  about its centre along its own sides, even when turned. **Rotate**: drag the
  circle above it (below it when the item is at the top edge), in 5° steps. A cable's points each have a handle; drag one to
  move that point. Mouse, pen and touch work alike, and two fingers pinch to zoom.
- **Keys**, while the plot has focus (pressing it gives it focus): the arrow keys
  move the selected item 4 units, 20 with Shift; Delete or Backspace removes it.
  Cmd/Ctrl+Z undoes and Shift+Cmd/Ctrl+Z redoes, anywhere on the page but in a
  field.
- **Inspector**: the item's kind with **Duplicate** (a copy a little down and
  right) and **Delete**; its label; for text, Label, Callout or Dimension; a colour,
  one of the patch sheet's ten swatches or none; width, height and rotation (a
  cable shows **Dashed** and its point count instead); notes, shown when someone
  taps it; and its inputs.
- **Undo and redo** cover the draft. A drag, a resize, a rotate or typing in one
  field is one step, however long it takes.

Every change stays inside the plot and within the size limits, so a draft can
always be saved.

**Save and Discard.** While the draft differs from what is saved, a banner says
so: **Save** sends it, **Discard** puts back what is saved. Nothing reaches
`/stageplots` until Save. Each save carries the version of the plot it started
from. If the plot was saved from somewhere else since, the save is refused and
nothing is overwritten: the banner says the plot changed elsewhere and offers
**Reload**, which shows the saved plot and drops the draft. A change elsewhere to
the plot's name or fade does not count, nor does a background change that moved no
items; a save refused for one of those before its news arrived is sent again on the
new version. A background change that moved items does count. Nothing counts while
the draft has nothing unsaved, which simply shows the new plot; undoing back to
that clears the banner. Leaving the page,
switching venue or plot, or **+**, **Duplicate** or **Delete…** on a plot ask
first while there are unsaved changes.

### Item types

| Type | Draws |
|---|---|
| Box, Circle | a shape, lightly filled in its colour |
| Zone | a dashed, translucent area: a choir, a baptistry |
| Cable | a line through its points, dashed or solid, with a dot at each end |
| Connection point | a floor pocket, stage box or wall plate |
| Symbol | one of nine drawings: drum kit, grand piano, keyboard, floor wedge, amp, mic stand, console, speaker, camera |
| Text: Label | words on the plot, sized with it |
| Text: Callout | a numbered dot; its text is listed in the legend's callout key |
| Text: Dimension | a line with end ticks and arrowheads, its label above |

Zones are drawn under shapes, shapes under cables, cables under symbols and
connection points, and text on top; the selected item is drawn above everything.
A new symbol is labelled with its name, a new cable is dashed, and a new label,
dimension or callout reads "Text", "10 ft" or "Note".

Labels stay the same size on screen at any zoom, and read level however an item
is turned. Shapes and symbols scale with the plot.

### Labels

A label is free text, up to 60 characters. The field suggests labels this venue
already uses (on the plot being edited, unsaved ones included, and on the venue's
other plots), then starter gear: drum kit, grand piano, keyboard, floor wedge,
guitar amp, bass amp, mic stand, FOH console, speaker, camera, DI box, stage box,
IEM transmitter. The whole list shows when the field takes focus and narrows as
you type, the matching part marked. The arrow keys move through it and Enter takes
the highlighted one; anything typed is used as it is.

### Inputs

Any item can list what plugs in there, in order: up to 64 inputs of 40
characters each, typically on a connection point. **Add input** adds a row and puts
the cursor in it. The inputs show, numbered, when someone taps the item on
`/stageplots`, and printed beside the plot for each connection point.

### The legend

Under the plot, in the editor and on `/stageplots`: one row per label and colour,
with a drawing of the item, so two orange "Floor wedge" read as one row, "×2".
Unlabelled items and text are left out. Callouts follow, numbered in the order
they were added, with their text.

### Printing

**Print** opens the browser's print dialog with the plot on one landscape page:
the venue and plot, "Default plot" when it is, the date printed in the app's time
zone, the plot, its legend and callout key, and each connection point's inputs.
The page is white paper in either theme. To make a PDF, choose Save as PDF in the
dialog. The browser's own print (Cmd/Ctrl+P) gives the same page.

The legend sits beside the plot in one or two columns. A legend too long for two
moves to a second page, in four columns, and the plot keeps the whole first page.

In the editor, Print shows the plot as it stands, unsaved changes included.

## Limits

50 venues, 20 plots a venue, 50 backgrounds, names of 60 characters and notes of
500, and 2000 plan overrides across every venue, past plans included. A plot holds up to 500 items; an item's label is up to 60 characters, its
notes 500, and its inputs up to 64 of 40 characters each.

## Backups

A config backup carries `stageplots.json` (venues, plots, backgrounds and every
plan's override), both folders of background files and
every PDF original, and a restore brings them all back. A photo background is
about 1 to 3 MB of source plus at most 1 MB of WebP. One made from a PDF carries
the PDF as uploaded too (up to 25 MB), beside its page's source, which for a
scanned or detailed page can be a few MB as a PNG.

A backup restored from a downloaded file is limited to 64 MB, about 48 MB of
files. Photos rarely reach that: twenty photo backgrounds come to about 40 MB.
PDFs do: two 20 MB plan sets, with their pages, already pass it, and a server
holding them cannot be restored from the file. Saved snapshots, recalled on
the server itself, have no such limit. Taking a backup past it logs a
`[config-snapshot]` warning with the total. See
[Reliability and data](../ops/reliability.md).

## Log

Lines tagged `[stageplots]`: every upload refused and why, a PDF kept, a
background accepted with its size before and after and the source kept, a conversion that failed, a
background over 1 MB at the lowest quality, a clean-up re-conversion or one refused
because its source is missing, a venue or background deleted, files tidied away or
left behind, the tidy skipped and why, image processing unavailable because sharp
did not load, a save that failed, every item save refused and why (a body that is
not a JSON object or is too large, an unknown plot, an item that breaks a rule, a
version that is not a whole number, "changed elsewhere"), how many items moved
up onto a plot once its background change is saved, every plan override set or
handed back to the default, every override refused and why, and the plan
overrides cleared with a deleted plot.
A page that cannot read the plots logs that too, and so does a print whose
background did not load. See [Updates and logs](../ops/updates-and-logs.md).

## API

The routes are in the [API reference](../reference/api.md#stage-plots).
