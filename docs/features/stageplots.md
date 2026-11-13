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

- With exactly one home venue, `/stageplots` opens it directly.
- The browser remembers the last venue opened and opens it next time; **Stage
  plots** above the venue's name goes back to the list and forgets it.
- Pinch or Ctrl/Cmd-scroll to zoom, drag to pan, and the buttons in the plot's
  corner zoom in, out and back to the whole plot. An ordinary scroll pans only
  once the plot is zoomed in, so the page still scrolls past it.
- Tap an item for its label, kind, notes and numbered inputs: beside the item on a
  desk, as a sheet along the bottom on a phone. A connection point linked to the
  patch lists its patch channels instead (see [Patch link](#patch-link)). A tap on
  the empty plot, anywhere off the plot, or Escape closes it; text has no details.
- **Print** beside the venue's name prints the plot (see [Printing](#printing)).
- A saved edit anywhere shows without a reload.

**Edit** in the bar opens the editor.

### Following the plan

The page follows the live or next Planning Center plan, the plan
[/patch](../patch-sheet/README.md) follows. A venue shows that plan's override
if it has one (see [Default and this week](#default-and-this-week)), labelled
**For this plan · Sun 15 Nov**, and otherwise its default plot, labelled
**Default**. When the stage moves on to the next plan, every open page follows
without a reload; a tab picked by hand gives way to the new plan's plot. The
date is the plan's, in the [app time zone](../ops/install-and-config.md#time-zone).

- With no plan live or coming up, or Planning Center not connected, each venue
  shows its default and no notice.
- When Planning Center cannot be read, each venue shows its default under
  "Planning Center is unreachable, showing the default plot." The page asks
  every minute while it is open. A read that fails, or answers that Planning
  Center cannot be reached, counts the same: one after a good answer changes
  nothing, two in a row put up the notice, and the next good one takes it down.
- On opening, the page waits up to two seconds for the plan list before it
  draws; once drawn it never blanks while a later read is slow.

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
- **Another plan…** lists the plans still to come from the list the slot
  editor's plan switcher walks (the next two months, every service type the
  Plan tab enables); pick one, then its plot. Two plans on one day are told
  apart by their time, "Sun 22 Nov 9:00".

With Planning Center not connected the card says so and offers no plan; with
it unreachable, the card says other plans can't be listed.

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

### Patch link

A connection point can follow a device on the [patch sheet](../patch-sheet/README.md).
At the foot of its inspector, **Link to patch device** opens a picker: choose the sheet,
then the device (each listed with its colour, name, kind and connector counts), and
**Link**. The point takes the device's name and colour, and both are locked while it is
linked: "Name and color follow the patch device." The inspector shows the device with
its kind, sheet and connectors, and **Unlink**, which keeps the name and colour the point
showed and makes them its own again. Linking and unlinking are draft edits, saved with
**Save**. Nothing here writes to the patch sheet.

A linked point follows its device. Rename or recolour the device on the patch sheet and
the point shows the new name and colour in the editor and on `/stageplots` at once, with
nothing to save; the next **Save** of the plot keeps them as its last. A device colour
that is not one of the ten swatches takes the nearest one.

A tap on a linked point on `/stageplots` lists **Patch channels · *sheet***: each channel
whose path runs through the device (for a rack, each channel set on it), inputs then
outputs, as its console channel, its source or destination, and its connector on the
device, such as `Ch 3 · Snare Top · SB-1/3`. Unused channels are left out. They are the
patch as the followed plan has it, its variant and that week's tweaks included, the way
`/patch` shows it (see [Following the plan](#following-the-plan)). A linked point with no
channels through it lists its own inputs.

When the device is no longer on the sheet the point reads **unlinked · device removed**;
when the patch sheet cannot be read, **unlinked · patch sheet unavailable**. Either way it
shows the name and colour it last saved, a tap lists its own inputs, and the plot still
saves. An unavailable sheet is followed again once it can be read (an open page reads it
again on a backoff, from a minute up to fifteen, and at once on any patch save); a removed device needs
**Unlink**, and a new link if one is wanted.

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

## Publishing

A venue can be put on the [ServiceCue public page](../ops/servicecue-on-the-web.md)
behind a secret link, for a crew who are not on the building's network:
`<page address>/stageplots/<secret>`. The page is the venue as `/stageplots` shows it,
read-only: its plots as tabs, the one it showed when it was published selected and marked
**Default** or **For this plan · Sun 16 Nov**, pinch zoom and pan, a tap on an item for its
label, notes and inputs, the legend and the venue's notes. There is no venue list, no
editor and no print. The page reads the venue again when it comes back into view; a plot whose read
fails keeps the copy it had and says it could not refresh, and one that has never loaded
says so rather than drawing an empty stage.

**Anyone with the link can see that venue's plots, item notes and inputs included.** For each
[linked connection point](#patch-link) that includes the patch sheet's name and the channels a
tap lists. The link is 43 random characters, so it cannot be guessed, and nothing on the page
lists venues; but whoever is sent it can send it on. A link that was never published, one that
was regenerated or unpublished, and a mistyped one all answer exactly as an address the
page does not know.

It uses the page address and publishing token saved under **Settings → Advanced →
Public link**; ServiceCue publishing itself does not have to be switched
on. The page must be deployed from a release with StagePlots in it: an older one is
refused with "*host* does not know StagePlots yet: deploy the Worker", and is fixed by
[updating the page](../ops/servicecue-on-the-web.md#updating-it).

The **Publish** card, at the foot of the editor's left column, is per venue:

| | |
|---|---|
| **Off** | **Publish *venue***. Nothing is sent until it is pressed |
| **Published** | When it was last published, the link with **Copy**, **Regenerate…**, **Unpublish…**, the backgrounds not yet published with **Publish now**, and the last error |
| **Old links still live** | Under either state, and on its own when no venue is selected: "*n* old links still live on *host*", with **Remove now** when that page is the one set up, and "Set that page up again to remove it" when not. See [Old links](#old-links) |

- **Publish** makes the secret on the server, sends every background the venue's plots
  draw, then each plot, then the venue itself. If the page refuses or does not answer,
  the venue stays unpublished and the card says why. A background the page refuses on
  its own (too large, say) does not stop the rest: the plot is drawn without it and the
  card lists it as not yet published.
- **Republishing** is automatic. Any saved change to the venue, its plots, its plan
  overrides or its backgrounds, and the followed plan moving, is sent about two seconds
  later; only what changed is sent. If it fails, the page keeps what it had, the card
  shows the error, and the next change or **Publish now** tries again.
- **Publish now** sends everything again, the backgrounds not yet published included.
- **Regenerate…** publishes the venue under a new secret, every background the old link
  has included, and only then removes the old link. If anything fails, the old link keeps
  working and the card says so. A background the old link never had (one the page refused)
  does not stop it: it stays listed as not yet published. If the old link cannot be
  removed, it waits as an [old link](#old-links). A regenerate is refused while 200 old
  links are waiting, before anything is sent.
- **Unpublish…** removes the venue's page and backgrounds from the public page. If the
  page refuses, the venue stays published and the card says the link still works. With no
  page set up, or the venue published to a page other than the one set up, the venue is
  unpublished here and its link waits as an old link, and the card says it is left on that
  page until the page is set up again. Publishing again makes a new link.
- **Deleting** a published venue unpublishes it first. A link the page does not take
  down waits as an old link, and the delete says so.
- **Copy** copies the link. Over plain HTTP, where the browser has no clipboard API, it
  selects the link for copying by hand if the older copy command does not work.

The page shows the plot each venue had for the followed plan when it was last published,
and republishes when the plan moves, so it follows the week as `/stageplots` does. Dates
are in the app's time zone.

A [linked connection point](#patch-link) is published as its device's name and colour and
the channels a tap lists, resolved when it is sent. Of the patch the page gets only that:
the sheet's name, and for each channel its console channel, its source or destination, and
the device's name with its connector. Never the link's ids, the other devices on a
channel's path, mics, notes, owners or anything else on the sheet. A patch save that
changes what a published point shows republishes that venue, and only that venue; one that
changes nothing a published point shows sends nothing. While the patch cannot be read,
linked points are published with their last name and colour and no channels; the server
reads it again every minute or so (backing off to every fifteen), and once it can, sends
each venue that links it again. After a restart it does the same once, so a page published
unlinked before it follows the patch again.

Saving a new page address in **Settings → Advanced → Public link** moves each published venue to the new
page straight away, under a new link (the address changes anyway, and so one link never
lives on two pages), then removes the old links from the old page with its token, which
the save still holds. An old link the old page will not take down waits as an
[old link](#old-links) on that page, removed once it is set up here again (or take it down
there, by deleting its Worker). If the new page will not take a venue (one deployed before
StagePlots, say), the venue stays on the old page with its link working, and the card says
why; **Publish now** tries the move again. A new token for the same address moves nothing,
and removes what waits on that page. Saving another address with no token for it, or
clearing the address, leaves nothing here that could reach the old page afterwards: each
venue on it is unpublished and its link removed with the old token, or kept as an old
link on that page if it will not go. Clearing only the token on the same address takes
nothing down; the token can be entered again. If the page settings cannot be read when
another address is saved, the venues on the old page are taken down with its token the
same way, since nothing here could reach it afterwards. A first publish still on its way
to the old page when the address is saved is waited for, and follows like the rest.

All of this runs after the save answers, since a move uploads every background. Anything
in it that fails is said on `/log` and never stops the old page's links being removed with
its token: a failure about one venue (a move that cannot be saved) is that venue's last
error, and what concerns the save as a whole (the settings unreadable, or old links that
could not be removed with the old token) is shown at the top of the Publish card, with or
without a venue selected, until the next save of the Public link. While a config restore
is landing, the Public link is not saved at all (`503`), so its old token is never
replaced before the stage plots can use it.

### Old links

No link is ever live on the page without this server knowing it. A link that nothing
shows any more (the old one after a regenerate, a venue unpublished or deleted while its
page could not be reached, a publish whose take-back failed, a link a restore wrote over)
waits in a list kept with the stage plots, and carried by backups, until it is removed. A
new link is written there before its first request goes out, and moves onto its venue only
once the page holds it all, so not even a crash halfway through a publish loses one.

The server removes what waits whenever it can reach the page: at start-up, on **Publish
now** and **Remove now**, and on every change. When the list itself cannot be read,
**Remove now** says so instead of reporting anything removed, and **Publish now** says it
beside the venue. A removal that fails is tried again then,
and said once on `/log`. Only the page a link was published to can remove it, with that
page's token: one on another page waits until that page is set up here again. The list
never leaves the server with its links in it; the card is told only each page, when and
why.

A plot over 2 MB once written out cannot be published: the card names it. That takes far
more than a working plot (hundreds of items with long input lists). A background over 2 MB
is listed as not yet published, with that reason.

The secret is in `stageplots.json` and so in config backups: anyone holding a backup can
open the venue's link. A restore merges the backup's links with the live ones so that none
is left live and unknown here and none that was revoked comes back: a link both hold stays
published; another server's links stay with it, unless this box replaces that server; and
every live link the restore does not keep is queued as an [old link](#old-links) and
removed at start-up, which takes down links made since the backup. The rules in full are
in [Restoring a config snapshot](../ops/reliability.md#restoring-a-config-snapshot). What the page holds and how it answers is
in the [publishing protocol](../reference/servicecue-publishing.md#stageplots).

## Limits

50 venues, 20 plots a venue, 50 backgrounds, names of 60 characters and notes of
500, and 2000 plan overrides across every venue, past plans included. A plot
holds up to 500 items; an item's label is up to 60 characters, its notes 500,
and its inputs up to 64 of 40 characters each. A tap on a linked connection point
lists up to 128 patch channels.

## Backups

A config backup carries `stageplots.json` (venues, plots, backgrounds, every
plan's override, each published venue's secret link and the old links waiting to be removed), both folders of background files and
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
handed back to the default, every override refused and why, the plan
overrides cleared with a deleted plot, and plan overrides in `stageplots.json`
that were not a list and were read as none. Publishing logs each publish (with how
many plots and backgrounds, and any background not yet published and why), each
republish that sent something, each Publish now, regenerate and unpublish, every one
that failed and why, every one refused before anything was sent (an unknown venue, one
published or not, no page set up, too many old links waiting), each old link queued for
removal, removed, failing (once) or waiting for its page (once), what went up before a
failure that could not be taken back, and each venue moved to a new page. The secret is
never logged. A publish that cannot read the patch sheet says so once (linked points go
out unlinked) and again when it can, and each plot sent with linked points that went out
unlinked names them and why (the device is gone, or the sheet cannot be read).
A page that cannot read the plots logs that too, so does one that cannot read the patch
sheet for its linked points, so does a print whose
background did not load, and so does a page that finds Planning Center
unreachable and falls back to each venue's default, and again when it can be
read once more. See [Updates and logs](../ops/updates-and-logs.md).

## API

The routes are in the [API reference](../reference/api.md#stage-plots).
