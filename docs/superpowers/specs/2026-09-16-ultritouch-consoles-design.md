# Consoles on a Ross Ultritouch

**Goal.** A control surface built in Stage Utility runs on a Ross Ultritouch
panel, sized to the panel's exact pixels, with buttons that fire cues and show
their live state, reached through DashBoard's Browser component.

**Mockup:** https://claude.ai/artifact/TgExaQ13h8Espb9SoeSAbC

**Why.** The control room already has Ultritouch panels, and their DashBoard
runtime can embed a web page in a Chromium frame. Stage Utility already has
consoles, panel-mode screens, custom canvases and Letterbox fit, so the panel is
mostly a new shape to design for. What it does not have is a shape that short,
a button that shows a cue's state, or a starting layout that reads at 203
pixels tall.

## The panels

From the Ultritouch User Guide (2201DR-304), the recommended full-display
resolutions:

| Model | Display | Ratio |
|---|---|---|
| Ultritouch-2 | 1366 x 203 | 6.7 : 1 |
| Ultritouch-2-HR | 1920 x 285 | 6.7 : 1 |
| Ultritouch-4 | 1366 x 485 | 2.8 : 1 |

PanelBuilder's own Ultritouch-2 template is 1304 x 203, so the panel's frame may
take 62 pixels of width. The presets use the guide's numbers. The Browser
component is drawn edge to edge on the DashBoard canvas and Letterbox fit
absorbs any difference as a sliver of background at the sides.

Confirmed so far: DashBoard's Browser component offers a **CHROMIUM** type, and
the VCR console rendered in it on a Mac at the panel's shape. Not yet confirmed,
because nobody has stood in front of the panel: that the Ultritouch's own
DashBoard has the Chromium type, and that a touch reaches the page.

## What already exists and is used as-is

- **Consoles.** A custom View with `surface: "console"`; its controls fire.
- **Panel-mode screens.** An Output with `mode: "panel"` may host a console and
  answers chrome-free at `/<id>` or `/<slug>`. Its **Hide top bar** setting
  removes the brand, plan and QR bar. This is what puts a console on a panel
  today, and the docs step below is to turn it on.
- **Canvas and fit.** `LayoutCanvas` holds `width`, `height` and `fit`.
  `"contain"` letterboxes: the layout keeps its shape and scales uniformly.
- **Cue state.** The cue manifest and `/api/cues/states` already know each cue's
  kind (switch or button), its on/off state, its state source, and whether it is
  available right now. The Home Assistant integration reads exactly this.
- **Actions.** `companion.press`, `rosstalk.command`, `osc.send`,
  `propresenter.macro`, `reaper.transport`, `pco.live.advance`,
  `display.refresh`, reachable from an `action-button`.

## What changes

### 1. Ultritouch canvas presets

Three entries in `CANVAS_PRESETS` (`renderer/editor/layout-templates.ts`) and
matching entries in the Screens page's shape list (`PREVIEW_ASPECTS` in
`renderer/settings/sections/view-detail.tsx`), labelled by model:

- `Ultritouch-2 · 1366 x 203`
- `Ultritouch-2-HR · 1920 x 285`
- `Ultritouch-4 · 1366 x 485`

Choosing one sets `fit: "contain"` and the fit control is disabled while an
Ultritouch preset is the canvas. A control surface for a panel whose pixels are
known has no reason to reflow, and a reflowed strip is exactly what turned the
VCR view into a stack of unreadable labels. Choosing a non-Ultritouch preset
re-enables the control and leaves `contain` in place.

The preset is recognised by its dimensions, not by a stored flag, so a layout
imported from another install behaves the same.

### 2. A cue button

A new layout object, the only piece of new capability in this design:

```ts
{ type: "cue-button"; cue: string; label?: string; showDevice?: boolean }
```

`cue` is a cue name from the manifest. The button renders the cue's label (or
`label`), the device it drives when `showDevice` is true, and a state mark:

| State | Look | Source |
|---|---|---|
| idle | grey dot | switch off, or a momentary button at rest |
| on | green ring and dot | `/api/cues/states` says on |
| pressing | accent fill | the press is in flight |
| stale | amber dashed ring, device line in amber | the state source is a Companion variable and Companion reports the connection down |
| unavailable | dimmed | the manifest says the cue is not available (for example not allowed during a service) |

A tap fires the cue through the same same-origin path a console's
`action-button` uses today, never through the token-gated `POST /api/cues/<name>`
which exists for external callers. A tap on an unavailable cue does nothing and
the button says why on a short press-and-hold, using the manifest's refusal
reason. A switch shows the state it *is in*, not the state it was asked for: a
press that Companion never applied leaves the button where it was.

State arrives over the existing event stream. If no channel carries cue states
today, one is added and the Home Assistant manifest's state reads move onto it,
so there is one source rather than two. Verifying which is the case is the
first step of the plan, not a decision made here.

Capability: `control` on a panel or console, `readout` on a wall display, so a
wall screen showing the same layout draws the state and fires nothing. It is
added to `CAPABILITIES` in `main/types/object-capabilities.ts`, which is
compiler-enforced exhaustive.

### 3. Strip starter templates

One template per preset, offered when a new console picks an Ultritouch canvas.
Each is a single row (two on the 4) of eight cue buttons and one readout at the
right, on the near-black kiosk ground. The buttons are placed to the mockup's
proportions; labels are sized as a fraction of canvas height so they stay
legible at the panel's real size:

| Model | Button | Label | Readout |
|---|---|---|---|
| Ultritouch-2 | 150 px wide | 26 px | 64 px mono |
| Ultritouch-2-HR | 210 px wide | 36 px | 90 px mono |
| Ultritouch-4 | two rows | 30 px | 120 px mono |

Template buttons are placeholders until the operator binds each one to a cue
in the editor; an unbound cue button renders its own outline and the word
"Unbound", never a fake state. The readout is the existing countdown object.

### 4. Docs

A new page, `docs/integrations/ultritouch.md`, covering both sides:

- Stage Utility: new console, Ultritouch preset, bind cues, new screen in panel
  mode with **Hide top bar** on, point it at the console, copy its URL.
- DashBoard: open an existing `.grid` or a new panel, Edit Mode, the **Browser**
  tool drawn edge to edge, Type **CHROMIUM**, the URL, Save As, Upload to
  Folder, Manage Open Views.
- Letterbox behaviour and why the fit is locked.
- What to check when the panel shows nothing: the Browser type, the URL scheme,
  and that the screen is in panel mode.

`docs/reference/layout-editor.md` gains the presets and the locked fit;
`docs/reference/widgets.md` gains the cue button.

## Logging

The cue button logs nothing of its own. A press lands in the automation log as
today, and a stale reading is already logged by the Companion health check.
Nothing new can fail silently here.

## Testing

- Presets: choosing an Ultritouch preset writes the dimensions and `contain`;
  the fit control is disabled; choosing another preset re-enables it. A layout
  with the same dimensions and no flag is recognised. Each guard proven red.
- Cue button: rendered state for each of the five states from manifest and
  state fixtures; a tap fires once and not while pressing; an unavailable tap
  fires nothing; a wall-display context renders the state and has no handler.
  The capability table's exhaustiveness is a compile error, not a test.
- Templates: each template's objects lie within the canvas, and the count of
  cue buttons is exactly eight (sixteen on the 4).
- Real path: a console with the Ultritouch-2 preset on a panel-mode screen,
  loaded in a browser sized 1366 x 203 and again in a taller window, shows the
  same strip at two scales. Driven against a test server, never the live one.
- On the panel: render, tap, and live state, checked in person. Recorded in the
  PR as done or not done.

## Out of scope, on purpose

- **A native DashBoard panel generator.** Only worth it if the Ultritouch's
  DashBoard turns out not to have Chromium. Held until that test.
- **A connected-clients log line and mark.** Today the server cannot say whether
  a display page is attached to it, which made this work hard to verify
  remotely. That is a separate small PR under the Sunday-morning rule.
- **Readouts beyond the countdown.** The existing readout objects already work
  in a strip; sizing them for it is the operator's job in the editor.

## Open questions for Henry

1. Which models are installed, so the templates get tested on the right ones.
2. Whether the Ultritouch's DashBoard offers the Chromium browser type.
3. Which eight cues belong on the VCR panel, so the first real layout is the
   template's test case.
