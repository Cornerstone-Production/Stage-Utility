# App shell redesign

**Status: design, not yet built.** This document describes intended behaviour, not
current behaviour. Nothing in it ships until the phase implementing it does.

All six sections are settled. Implementation plans are written one phase at a
time, against this document.

**Goal:** Stage Utility's features behave like separate applications that happen
to share a server. This redesign gives the operator surfaces one shell with real
navigation, turns the root URL into a working home rather than a link list, and
makes a layout something an operator can act on and edit in place — while a wall
display stays inert unless it is deliberately made a touch panel.

**Not in scope:** the visual language. Type, color tokens, materials and
elevation were settled in the design overhaul (see `STYLE_GUIDE.md`). This is
information architecture and interaction model, not a repaint.

---

## The problem

Four structural facts in the current code produce the "everything is a separate
URL" feeling:

1. **There is no router.** `renderer/main/router.tsx` uses
   `createMemoryHistory()`, which ignores the URL by design, and
   `renderer/main/root-view.tsx` then branches on `window.location.pathname`
   through an if/else chain. `/history`, `/patch`, `/baptism` and `/scriptview`
   are full-screen islands. Every move between them is a full page load, and
   there is nowhere to hang a navigation bar.

2. **The bundle split is drawn along the wrong axis.** `index.html` is the kiosk
   and `settings-window.html` is the admin app. The operator tools were filed
   into the kiosk bundle, so they inherit `classList.add("dark", "kiosk")`,
   `overflow: hidden`, and no chrome. `/history` cannot honor the light/dark
   toggle; the History settings tab can.

3. **Two features have two front doors, and two more only appear to.**
   `SECTION_PAGE` in `renderer/settings/settings-view.tsx` maps ScriptView,
   Patch, History and Baptisms to standalone pages, but only two are duplicates:

   - **History** — `history-view.tsx` (38 lines) renders `ServiceHistorySection`,
     the same component the settings tab renders. A true duplicate.
   - **Baptisms** — `baptism-operator-view.tsx` (35 lines) and
     `baptisms-section.tsx` (15 lines) both render `BaptismOperator`. A true
     duplicate.
   - **Patch** — `patch-view.tsx` (272 lines) is a volunteer-facing read view
     built on `resolvePatch`. The settings tab is the editor. Different surfaces.
   - **ScriptView** — `scriptview-index-view.tsx` (158 lines) is the rundown
     viewer. The settings tab is the column-preset editor. Different surfaces.

   Whichever door has navigation is the one that gets used, and today that is
   always the settings tab — so the standalone viewers are reached only
   deliberately, and the duplicates are pure maintenance cost.

4. **Editing exists only inside settings.** `layout-editor.tsx` (3,327 lines)
   lives in the settings bundle, so a layout can only be changed from a settings
   tab. Object rendering itself is already shared with the kiosk renderer
   (Section 5) — it is the editing chrome that has no home outside settings.

## Constraints

- **Wall displays are inert by default.** A screen bolted to a wall shows output;
  whoever walks past must not be able to change it or trigger anything. A screen
  becomes interactive only through an explicit, deliberate opt-in (Section 4).
- **Output clients stay thin.** A Raspberry Pi drives a display in a browser.
  That is the architecture's strength and the reason this stays a web app.
- **The server remains the single source of truth.** Clients are projections of
  it. No client-owned state that another client cannot see.
- **Prod is not a secure context.** Plain HTTP on a LAN address, so
  `crypto.randomUUID`, clipboard write, service workers and similar silently
  fail in production while working on localhost. Guard every such API.
- **This stays in the browser.** Native (`apple-ndi` branch) remains parked for
  NDI specifically, which browsers genuinely cannot do. Nothing in this redesign
  is blocked by browser capability.
- **Long-lived sessions become possible, and must be safe.** A full page load is
  a crude but total reset, and today every navigation performs one. Once the
  operator app is a persistent shell, a laptop left open through a service keeps
  one JS heap for hours, so leaked subscriptions, uncleaned timers and stale
  listeners accumulate where they were previously wiped on every navigation.
  Effect cleanup becomes load-bearing rather than hygiene.

### What the shell changes about loading

Bundle files were already cached across page loads, so download was never the
cost. The costs a persistent shell removes are:

- **Parse, compile and execute**, previously paid on every navigation and
  unhelped by caching. On a Raspberry Pi this dominates.
- **SSE reconnection.** Every page load drops and re-establishes the connection,
  and every reconnect triggers the hello burst — a full state snapshot. Five
  navigations produce five complete state dumps. A persistent shell holds one
  connection across every route change.
- **React Query cache loss.** `QueryClient` already exists in `router.tsx` but is
  discarded on each load; in a shell, plan and PCO data are fetched once and
  reused across routes.

**Route-level code splitting is required, not optional.** Without it the shell
would carry History's charts, the layout editor and the patch table on first
load whether or not they are visited, making first paint worse than today. Split
per route, each downloads on first visit and is cached after.

The display bundle stays separate throughout, so an output client receives none
of this.

---

## Section 1 — Architecture and the surface model

### Where the line goes

The split moves from *settings vs everything else* to **operator surfaces vs
output surfaces**.

- **The operator app** — browser-history routing, persistent navigation, one
  shell. Every surface a human drives: Home, Consoles, Screens, Patch,
  ScriptView, History, Baptisms, Automation, and a small Settings area for
  genuine configuration. `settings-window.html` retires and its sections become
  routes. (The rail is settled in Section 2.)
- **The output surface** — screens pinned at `/display-N`. Chrome-free, forced
  dark, and read-only unless explicitly made a touch panel (Section 4).

These stay **two HTML entry points** rather than merging into one bundle. The
decision is close — a single entry with route-level code splitting would be
tidier — but two entries buy three things:

- the display HTML sets `dark`/`kiosk` and its body styles before paint, where a
  single entry would flash the wrong background on a TV while the route resolves;
- a Pi never downloads or parses operator code;
- a fault in operator code cannot take down a screen that has been running for
  months.

The shell and router work is identical either way, so this is reversible.

### Display and console

A View declares what it is for. `View` (`main/types/views.ts`) gains a field
alongside the existing `kind`, orthogonal to it:

```ts
surface: "display" | "console"
```

| | Display | Console |
|---|---|---|
| Where it renders | `/display-N`, bound to an Output | the operator shell, or a `panel` Output |
| Chrome | none | full navigation (none when pinned to a panel) |
| Theme | forced dark | follows the user's toggle |
| Controls | none | live |
| Drill-down | no | yes, in the shell |
| Editing | no | yes, in the shell |
| Audience | anyone walking past | the operator |

The `panel` case — a console pinned chrome-free to a physical screen, which is
how a touchscreen is built — is defined in Section 4.

A layout is designed for one context, not both. A display View is laid out to be
read from across a room and carries no controls; a console View is laid out for
arm's length and can carry controls, drill-down targets and editable fields.
A single layout forced to serve both is worse at each.

**Binding rule.** A `display` Output may only be bound to a display-surface View,
enforced in the server's `setOutputView` handler rather than only in the settings
dropdown. Binding a console View requires the Output to have been deliberately
set to `panel` (Section 4). A wall screen therefore cannot render a live control
by accident. Its test must attempt the binding and assert the refusal — not scan
source for the check.

**Converting a bound View refuses** with a message naming the Output it drives,
rather than silently unbinding it.

**Which kinds can be consoles.** Any, schema-wise. In practice `custom` is the
only kind with an editable layout and therefore the only one that can carry
controls, so it is the only kind offered as a console initially. Other kinds may
gain console affordances later — drill-down on a dashboard View, for instance —
without a schema change.

**Migration** is behavior-preserving rather than a blanket default, because
control objects already exist on some Views today. The rule is defined in
Section 4.

**Views list.** The Views surface groups into Displays and Consoles, and surface
is chosen at creation rather than converted afterwards.

The existing settings live preview (`/preview-<view>`) renders a View in its own
declared surface, rather than remaining a third presentation.

### Cost

- `router.tsx` moves from `createMemoryHistory()` to browser history;
  `root-view.tsx`'s path-switch is deleted.
- Twelve settings sections become routes. `settings-view.tsx` (1,506 lines)
  sheds its tab-state machinery.
- History and Baptisms collapse to one route each; Patch and ScriptView keep both
  surfaces, with the editor reached from the viewer.
- Object rendering is already shared between the editor and the kiosk renderer
  (Section 5), so this phase inherits WYSIWYG rather than having to build it.

---

## Section 2 — Navigation and information architecture

### Shell chrome

Three parts on every operator surface: a **rail** (navigation, collapsible), a
**context bar** (live service state), and the content area.

The context bar is the element that most changes how connected the app feels.
Today every page is context-free — `/patch` cannot tell a service is live,
`/history` does not know what today is — and the live state exists only on
whichever View happens to render it. Hoisting it above the page requires no new
server work: `use-service-timeline`, `use-stage-state` and the PCO live poller
already carry all of it.

### The rail

```
[logo] <appName>
Home · Consoles ▸ · Screens · Patch · ScriptView · History · Baptisms · Automation
─────────
Settings · theme · version
```

**Brand is fixed in the rail header** — `BrandLogo` plus `appName`, always
visible, never toggleable. It is identity rather than context, and it is the
first thing that differentiates one church's install from another's.
`renderer/settings/brand-header.tsx` moves up into the shell.

**Plan folds into Home.** Its service-type and plan selection is exactly what the
context bar carries on every page; the remainder becomes the substance of the
home dashboard.

**Consoles are listed individually** in the rail rather than behind a picker,
with a "New console" affordance beside them. A console used every week should be
one click from anywhere.

**Settings shrinks to four genuinely set-up-once surfaces:** Integrations,
Connect, Branding, Advanced. Everything else in today's settings panel is work
and moves to the rail.

**Front doors resolve by kind, not uniformly.** History and Baptisms are true
duplicates and collapse to one route each. Patch and ScriptView are not: the
standalone page is the surface people use (the volunteer patch view, the rundown
viewer) and the settings tab is its editor. For those two the rail item is the
**viewer**, with the editor reachable from it — configuration hanging off the
thing it configures, rather than living in a separate panel.

### Screens: merging the Views and Outputs surfaces

`views-section.tsx` (content) and `outputs-section.tsx` (physical screens) become
one surface: a card per Output showing what it is currently displaying and
whether it is online, with the display-View library alongside. Assignment
happens directly rather than through a dropdown in a different tab.

This merges the presentation only. The Views-and-Outputs data model is correct
and unchanged — a View is content, an Output is a screen, one View can drive many
Outputs.

### The context bar is configurable

A fixed bar would be wrong as soon as another integration lands. Instead, a
**registry of bar items**: each declares an id, a label, an icon and a compact
renderer. The operator chooses which appear and in what order.

Shipping set: clock, service type and plan picker, live state and service timer,
current plan item, integration health, recording status. A stream-status item
(YouTube/Resi) registers itself when that integration is built.

Three requirements, each reflecting a failure this repo has already had:

- The bar configuration is operator config: a `DataStore` declared `"config"`,
  added to `CONFIG_FILES` in the same change, or it is silently absent from every
  backup.
- The registry must be **compiler-enforced**. This becomes another place a new
  integration has to register itself, and source-scanning guards here have
  repeatedly passed while missing entries.
- **Bar items share data hooks with layout objects, not components.** An
  OBS-recording bar item and the OBS-status layout object both read
  `use-obs-state`; they render differently because a compact strip and a
  free-form canvas box are different presentations. Shared logic, separate
  rendering.

The bar is global configuration, not per-device — consistent with the
server-as-source-of-truth model, and it makes the context genuinely shared.

## Section 3 — Home

### The root URL

`/` currently renders the display picker, so a freshly-pointed wall monitor can
choose what to show. Home takes the root URL instead, because opening the app
happens weekly while commissioning a screen happens a few times a year.

Home carries a **"Use this screen as a display"** action that opens the picker.
The commissioning flow costs one extra click, once per screen, and stays
discoverable because it sits on the page everyone lands on.

### Two states

A dashboard that looks the same mid-week and mid-service is reporting rather
than participating. Home renders differently depending on whether PCO reports a
service live.

**Live.** The service timer and current plan item own the screen, with the next
item queued, recording status, current SPL, attendance, and which Outputs are
online.

**Idle.** Next service with a countdown, this week's plan summary, and a
**readiness** block: integrations connected, Outputs online, patch sheet current
for this plan, ScriptView populated. "What is not ready for Sunday" is the
question the app cannot currently answer.

Beneath both: attendance trend, SPL averages and service duration as headline
summaries that **drill into History** rather than duplicating it. History already
computes these (`attendance-history-section`, `spl-history-section`,
`AttendanceTrendChart`); Home shows the headline and the click opens the detail.

### Composition

Home is built from the same widget set as consoles and layout objects. A bespoke
Home would be a further surface to maintain and would drift from the others.

Home ships first as a **fixed arrangement** of those widgets (Phase 2), and
becomes an editable console once edit mode exists (Phase 4). The widgets are
identical in both cases, so nothing built early is discarded, and Home is useful
long before editing lands.

## Section 4 — The object capability model

### Controls reuse the automation action registry

`ActionDef` (`main/types/automation.ts`) already defines every action the app can
perform: `{ id, label, params, run() }`, contractually non-throwing, returning an
`ActionResult`. Only the automation engine can currently invoke it.

A **control object references an `ActionDef` by id, with params**. One registry of
capabilities, two ways to invoke it: a rule fires it on a trigger, or an operator
presses it on a console. `ParamDef` already renders form fields for the
automation UI, so the layout inspector configures action params with the same
machinery.

`osc-button` and `rosstalk-button` become specializations of a general action
button. Both are retained unchanged so existing layouts keep working.

**Consoles may advance PCO Live.** Advancing the service plan is an ordinary
control, not a restricted one, so `live-controls` stops being a special case and
becomes a regular control object backed by an `ActionDef`. The capability gating
below is what keeps it off a read-only wall display.

### Capabilities

Each object type declares what it can do. Capabilities compose — an SPL meter is
both a readout and a drill-down target.

- `readout` — renders data
- `control` — invokes an `ActionDef`
- `drilldown` — declares a route target
- `editable` — writes back to a store

Drill-down targets: SPL meter to SPL history, people counter to attendance
trend, wireless channel to its patch row, integration status to that
integration's settings. Each object type declares one target route.

Inline editing adds two object types, **notes** and **checklist**. Both hold the
operator's work product, so both are `"config"` stores and both are added to
`CONFIG_FILES` in the same change.

### Rendering contexts

`Output` gains a mode alongside the View's `surface`:

- **`display`** (default) — binds display Views only. Read-only wall screen.
- **`panel`** — binds console Views. Chrome-free, no rail or nav, controls live.

| | display Output | panel Output | console in the shell |
|---|---|---|---|
| readout | yes | yes | yes |
| control | no | yes | yes |
| editable | no | yes | yes |
| drill-down | no | no | yes |
| layout editing | no | no | yes |

Drill-down is inactive on panels because there is no navigation to drill into.
Layout editing stays in the operator shell so a pinned panel cannot be
rearranged by whoever is standing at it.

The safety property comes from an explicit opt-in: an Output is `display` unless
deliberately changed to `panel` in Screens. Nothing becomes interactive by
accident.

### Migration

Three interactive object types already exist — `rosstalk-button`, `osc-button`
and `live-controls` — and they render on wall displays today. Migrating every
existing View to `display` would silently disable the buttons on any touch panel
currently in service.

Migration is therefore behavior-preserving: **any existing View containing a
`control` object migrates to `surface: "console"`, and the Outputs bound to it
migrate to `panel`.** Current behavior is preserved with no operator action.
What was migrated is logged, so a stray `live-controls` object that pulled a
wall display into `panel` can be demoted deliberately.

The migration test must build a View with an OSC button bound to an Output, run
the migration, and assert the button still fires — not merely assert the field
values.

## Section 5 — In-place editing

### The renderers are already shared

`renderer/settings/sections/layout-editor.tsx` imports `ObjectContent`,
`boxStyle`, `useLayoutData`, `loadProcessedAttachment` and `LayoutRenderCtx`
from `renderer/main/layout-renderer.tsx`. Object rendering has never been
duplicated. The editor's 3,327 lines are editing chrome: palette, inspector,
drag and resize, marquee, multi-select, clipboard, alignment, canvas controls.

WYSIWYG is therefore already true, and in-place editing is a smaller change than
its file sizes suggest.

### The work

- **Relocation.** The editor sits in `renderer/settings/sections/` only because
  that was its bundle. Once settings dissolves into the operator app there is one
  bundle, and this becomes a file move.
- **Split `layout-editor.tsx`** into canvas/interaction, palette, inspector and
  toolbar. It is the largest file in the repository and is about to gain a second
  consumer.
- **Edit mode on a console route.** The console renders normally; the editing
  chrome overlays it. This is the only genuinely new piece.
- **Conflict detection is reused unchanged.** `View.rev` is bumped on every
  layout save, and the editor returns the revision it opened so a save built on a
  layout someone else has since replaced is detected rather than silently
  overwriting their work.
- Editing chrome never mounts on a `display` or `panel` Output.

### Console sizing

`LayoutCanvas.fit` already offers `"contain"` (letterbox the design aspect) and
`"fill"` (reflow the fractional positions to the window). Positions are fractions
of the canvas and font sizes are fractions of canvas height, so both scale.

**Consoles default to `fill`**, using the whole content area rather than
pillar-boxing a 16:9 design into a laptop window. **Displays keep `contain`**,
since a wall screen has a known aspect and the design should be honored exactly.

`fill` reflows proportionally, so a layout designed at 16:9 distorts at a very
different aspect ratio. It is not a responsive grid. This is acceptable for
consoles on laptop-shaped windows; a responsive layout mode would be a separate
later change, and nothing in this design blocks it.

---

## Section 6 — Editing interaction and object polish

### One layout model

Free-form absolute positioning stays, for displays and consoles alike. No grid,
no neighbour reflow: dragging an edge or corner resizes that object only.

What changes is the feel. The object's **content reflows continuously during the
drag** rather than showing a wireframe until release, so the result is visible
while it is being chosen. Magnetic snapping to other objects' edges, to canvas
thirds and to the grid, plus alignment guides, replace the tidiness a grid model
would have provided.

### Resize behaviours

Every object must survive being dragged to any dimension. The 38 object types
fail differently: `slide-thumbnail`, `brand-logo`, `image` and `ndi-video` have
intrinsic aspect ratios; `transcript-strip`, `current-slide-notes` and
`service-order` overflow; `slots-grid`, `charger-battery` and `people-panel` have
grid cells with natural sizes; `people-graph` and `spl-meter` must redraw at any
shape.

Rather than 38 bespoke fixes, each type declares one **resize behaviour** —
`fluid`, `aspect-locked`, `reflow-grid`, `clamp-text` or `redraw` — implemented
once each. The declaration is compiler-enforced, so a new object type cannot be
added without choosing one.

### Default-first styling

Per-object Type/Fill/Border/Elevation controls are most of what makes the editor
read as an engineering tool. They are removed from the inspector in favour of a
strong default look.

Sequencing matters: the defaults must be good before the controls are removed,
or a layout that looks wrong cannot be corrected.

Existing layouts carry custom styles, and removing the controls must not repaint
running displays:

- the renderer keeps honouring stored `LayoutStyle` values;
- the inspector stops offering the controls by default;
- an explicit **"Reset to default look"** action exists per object and per view,
  so adopting the new defaults is a deliberate choice;
- advanced styling remains available behind a disclosure.

Consequence, accepted: existing displays keep their current appearance until
reset deliberately.

### Colour

The default look derives colour from **semantics and category**, not decoration.
Status ramps (live green, over red, caution amber) plus the existing categorical
helpers — `category-color.ts`, `channel-color.ts`, `item-color.ts`, and the patch
sheet's device and rack colouring — supply it.

This is consistent with the locked design direction rather than a reversal of it:
that direction governs chrome (rail, cards, navigation), which stays quiet. The
data is what carries colour.

### Motion and interaction quality

A cross-cutting requirement, testable rather than a matter of taste:

- Motion tokens — a small shared set of durations and easings, not per-component
  values.
- Animate `transform` and `opacity` only. Never `width`, `height`, `top` or
  `left`.
- Drags use `setPointerCapture`, batch pointer-move updates through
  `requestAnimationFrame`, and never write React state per move event.
- `prefers-reduced-motion` is honoured throughout.
- The 60fps budget is measured on a Raspberry Pi for display surfaces, not only
  on a development laptop.

### Verification

Pointer-drag interactions cannot be verified by tooling in this repository —
prior marquee and group-move work type-checked and built cleanly and still
required a human click-test. Anything in this section ships with a recorded human
test or it does not ship verified.

---

## Phasing

Each phase ships on its own and leaves the app working.

**Phase 1 splits in two.** Doing it as one change would mean adding a router,
adding a shell, extracting roughly forty handlers out of a 1,506-line file and
moving twelve sections, in a single reviewable unit — while Settings is the
app's entire control surface, so a regression leaves the operator unable to
configure anything.

**Phase 1a — The operator shell (additive).** A third entry point with
browser-history routing, the rail and the context bar. It takes over `/patch`,
`/history`, `/baptism` and `/scriptview` from the kiosk bundle and adds
`/automation` and `/integrations`. The existing settings panel keeps working,
untouched, at `/settings`. Nothing is removed, so a fault is recoverable by not
using the new URLs. Six of the twelve sections (`scriptview`, `integrations`,
`service-history`, `baptisms`, `patch`, `automation`) already take no props and
move as-is.

**Phase 1b — Dissolving Settings.** Extract the shared `stageState` and
`SectionHandlers` into a provider, move the remaining stateful sections
(`plan`, `views`, `displays`, `connect`, `branding`, `advanced`) onto routes,
retire `settings-window.html`, and redirect its hash-based deep links
(`/settings#integrations`) to the new routes.

Together these fix the daily complaint (`/history` versus the History tab).

**Phase 2 — Home and Screens.** Home at the root URL with live and idle states,
readiness, and drill-down into History; "Use this screen as a display" preserves
commissioning. Views and Outputs merge into one Screens surface.

**Phase 3 — Surfaces and capabilities.** `View.surface`, `Output` mode, the
behavior-preserving migration, the capability model, control objects bound to
`ActionDef`, drill-down targets, and the notes and checklist objects.

**Phase 4 — In-place editing.** Split the editor, mount edit mode on console
routes, consoles default to `fill`.

**Phase 5 — Editing interaction and object polish.** Resize behaviours across all
38 object types, live reflow during drag, snapping and alignment guides, the
default-look styling pass and "Reset to default look", motion tokens. Separable
from Phase 4: Phase 4 puts the existing editor where it belongs, Phase 5 makes it
feel right.

The configurable context bar can land in Phase 1 with a fixed item set and gain
its registry in Phase 3, when integration health and recording status arrive.

## Testing

The repository's standing rule applies throughout: a guard must fail on the bug
it guards, demonstrated by reintroducing the bug and watching the test go red.

- **Migration.** Build a View carrying an OSC button bound to an Output, run the
  migration, and assert the button still fires. Field-value assertions are not
  sufficient.
- **Binding rule.** Attempt to bind a console View to a `display` Output and
  assert the refusal, exercising the server handler rather than the UI.
- **Capability gating.** Render a control object in all three contexts and assert
  it fires only where it should.
- **Bar-item registry.** Compiler-enforced, not a source scan. Source-scanning
  registration guards in this repository have repeatedly passed while missing
  entries.
- **Config stores.** The context-bar configuration, notes and checklist stores
  are declared `"config"` and added to `CONFIG_FILES` in the same change;
  `config-snapshot.test.ts` fails otherwise.
- **Routing.** Every collapsed front door keeps a working URL, so existing
  bookmarks and the Companion module's links do not break.
- **Resize behaviours.** Every object type declares one, enforced by the type
  checker rather than by a source scan, and asserted as an exact count so a new
  type cannot be added without a declaration.
- **Drag interactions.** Human click-tested and recorded. Tooling in this
  repository cannot drive React canvas pointer-drags, and prior work here passed
  type-check and build while remaining unverified.
