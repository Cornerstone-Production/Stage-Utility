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
| `stageplot-images/` | the converted WebP, and the PNG or JPEG it was converted from | yes, cached forever |
| `stageplot-originals/` | an uploaded PDF | never |

Converting runs one image at a time, so a Raspberry Pi converting a 12-megapixel
photo does not hold two in memory.

## /stageplots

Read-only. The venues as cards, home then offsite, each with a thumbnail of its
default plot. A venue opens to its plots as tabs with the default selected, the plot
itself, and the venue's notes.

- With exactly one home venue, `/stageplots` opens it directly.
- The browser remembers the last venue opened and opens it next time; **Stage
  plots** above the venue's name goes back to the list and forgets it.
- Pinch or Ctrl/Cmd-scroll to zoom, drag to pan, and the buttons in the plot's
  corner zoom in, out and back to the whole plot. An ordinary scroll pans only
  once the plot is zoomed in, so the page still scrolls past it.
- An edit anywhere shows without a reload.

**Edit** in the bar opens the editor.

## /stageplots/edit

Venues and Backgrounds down the left, the selected venue's plots on the right.
Every change saves as it is made and every open `/stageplots` follows it; there is
no Save button. A change the server refuses says why beside the control, and the
page goes back to what is saved.

- **Venues**: **+ Venue** adds one and selects it. The selected venue's name and
  notes save when you leave the field; Home or Offsite saves at once.
- **Backgrounds**: **Upload**, the list, and the selected background's detail with
  its **Clean-up** switch and **Delete background…**.
- **Plots**: a tab per plot, **+** for a new one (it starts on the selected plot's
  background), and **⋯** on the selected tab for **Rename**, **Duplicate** (an
  independent copy named "… copy", which opens), **Set as default** and
  **Delete…**.
- **Toolbar**: zoom, the plot's **Background** (or **None (grid)**), and **Fade**,
  which previews on the plot while dragged and saves when let go.

## Limits

50 venues, 20 plots a venue, 50 backgrounds, names of 60 characters and notes of
500.

## Backups

A config backup carries `stageplots.json`, both folders of background files and
every PDF original, and a restore brings them all back. Every background carries
its source as uploaded (up to 12 MB) beside its WebP, and one made from a PDF
carries the PDF too (up to 25 MB), so backgrounds make backups large.

A backup restored from a downloaded file is limited to 64 MB, about 48 MB of
files. Four photos straight off a phone at 12 MB each already reach it, and a
server holding them cannot be restored from the file. Saved snapshots, recalled on
the server itself, have no such limit. Taking a backup past it logs a
`[config-snapshot]` warning with the total. See
[Reliability and data](../ops/reliability.md).

## Log

Lines tagged `[stageplots]`: every upload refused and why, a PDF kept, a
background accepted with its size before and after, a conversion that failed, a
background over 1 MB at the lowest quality, a clean-up re-conversion or one refused
because its source is missing, a venue or background deleted, files tidied away or
left behind, the tidy skipped and why, image processing unavailable because sharp
did not load, and a save that failed. A page that cannot read the plots logs that
too. See [Updates and logs](../ops/updates-and-logs.md).

## API

The routes are in the [API reference](../reference/api.md#stage-plots).
