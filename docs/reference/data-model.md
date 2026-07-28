# Data model and concepts

The nouns the app is built from — Views, Outputs, Slots and the rest.

## Data model & concepts

A **slot** is one channel strip on the display. Each slot has a `channel` label and
a **link** that decides who/what it shows (`renderer/types.d.ts`):

- `pco` **by position** — matches whoever fills a team position (e.g. "Electric Guitar").
- `pco` **by person** — pinned to a specific PCO person id.
- `static` — a fixed label + color (e.g. "Backup").
- `empty` — a placeholder.

A slot can optionally carry a **device binding** to a wireless channel, so the
display shows that pack's RF/battery next to the person. Slots can **stack** into a
shared on-screen column (mirrors two people sharing a dual-bay charger).

**Views & displays.** A **view** is a reusable content definition; a **display**
(output) is a physical screen at its own URL, routed to exactly one view. One view can
drive many displays, so you change content in one place. Both can be reordered. View
**kinds**:

- **Slots** — the channel grid (its own slot set, per service type). Only this kind uses the slot editor.
- **Dashboard** — clock, the PCO live countdown, and a ProPresenter now/next summary.
- **Stage** — a confidence view: current/next slide text, song section + chords, a
  live slide thumbnail, running timers, and the countdown.
- **Captions** — full-screen, auto-scrolling transcription from ProdCom.
- **Script** — a full service rundown: every plan item with PCO note-category columns,
  section headers, length, a clock and the live countdown, with the current item
  highlighted; an optional per-display PCO Prev/Next control.
- **SPL Rundown** — a compact item-plus-max-SPL list for the live service.
- **Custom** — a free-form layout authored in the **visual editor**: a fixed design
  canvas (default 1920×1080) of positioned **objects** — clock, countdown, current/next
  slide text + notes, slide thumbnail, section chip, mic-slots grid, transcript, SPL
  meter, charger battery, PCO live controls, brand logo, image, **plan file**, shape,
  text, **container**, plus the newer **people counter / summary / graph**, **OBS
  status**, **OSC button**, **integration status**, **wireless summary**, **caption
  filter**, **baptism timer**, and **service order** — each bound to the same live data.
  Positions and sizes are stored as fractions of the canvas, so a layout renders
  identically at any resolution.

  **Containers** are styled boxes that hold other objects: a child's position/size is a
  fraction of its container, so moving or resizing the container moves and scales its
  contents as a unit (nesting up to two levels). Drop a top-level object onto a container
  to nest it; pop it back out from the inspector or the layers panel. **Card presets**
  (Glass / Green / Red / Amber, or **Flat** to clear) apply the built-in dashboards'
  rounded "glass tile" look — fill, border, radius, padding — to any object in one click,
  fully opt-in and reversible. **Start from Dashboard** builds the dashboard layout
  (clock, PCO timer, current/next item, SPL, captions) as editable nested tiles. Style
  sizes (font, radius, padding, border) edit in px and opacity as a 0–100% slider.

  The **plan-file** object shows a file attached to the *current Planning Center plan* —
  e.g. the stage plot. It matches by filename (case-insensitive substring, default
  `"stage plot"`) across everything on the plan (plan Files, service-type files, item/song
  charts — via PCO's `all_attachments`), so it auto-tracks the live plan week to week
  without re-pointing. PDFs render client-side (pdf.js, lazy-loaded); images render
  directly. The server resolves + proxies the file (PCO only issues short-lived links) and
  caches it on disk by attachment id. The *rendered image* (not the source file) can be
  framed in the inspector: **crop** (edge insets), **trim** (auto-remove the white page
  margin), **background** (keep / fill black / knock white out to transparent), and a
  **fit box to file** button that matches the object box to the content's aspect ratio.

**Layout templates** are named custom layouts saved to a reusable library (save / load /
overwrite / delete from the editor). **Slot presets** similarly snapshot a slot
arrangement by name.

The full base state is the `StageState` object pushed over SSE; high-frequency data (the
PCO countdown, ProPresenter slide, and transcript) rides separate SSE channels so a
display can render and recover from each independently. The countdown matches PCO's own
behavior — it always counts **down** (to the service start, then per item), going
red/negative when an item runs over.

**Backward compatibility.** The older "a display *is* its content" model is preserved as
a computed compat shim in `StageState` (`displays` / `slots` / `slotsByDisplay`) so
existing clients keep working; on first run, existing displays auto-migrate to
views + outputs with their URLs and slot data intact.
