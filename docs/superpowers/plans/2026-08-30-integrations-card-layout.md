# Integrations as a card grid, settings in a dialog

**Goal:** the Integrations page stops reading as sixteen stacked full-width rows.
Each integration becomes a small card that answers "what is this, and is it
working"; its settings open in a dialog.

**Mockup:** https://claude.ai/code/artifact/63c4a1fe-1158-4333-b65a-feaf9a4a492c

**Scope:** `renderer/components/integrations-panel.tsx` and the three bespoke
panels currently defined inside it. No server change, no descriptor change, no
new dependency.

---

## What the page measures today

Driven in a browser against a real server on the beta tip (`95d47ed`), all
sixteen integrations rendered, "Not set up" expanded:

| | 1440x900 | 390x844 |
|---|---|---|
| Page scroll height | **4519px** (5.0 screens) | **5267px** (6.2 screens) |
| Card width | 1176px | 366px |
| Collapsed row | 51px | 51px |
| Expanded row | 161-409px | 193-558px |

The same page in the mockup's card grid measures **1292px** at 1400x920 — a
3.5x reduction — because no card holds a form any more.

### Every form control is narrow

Measured off the live DOM, the width of every control in all sixteen:

| Control | Rendered width |
|---|---|
| `text` / `password` `Input` | **176px** (`w-44`) |
| `NumberInput` | **125px** |
| `Select` trigger | **176px** (`w-44`) |

There is no wide control anywhere in `configSchema`, and nothing in the panel
overflows its container at any width. A 1176px-wide row is holding a 176px
input. **The row is full-width because the list is a list — not because the form
needs the space.** That is what makes both a grid and a dialog viable.

### Field counts, all sixteen

Read from `main/services/integration-manager.ts` (descriptors at lines 37-522).

| Integration | id | kind | Schema fields | Bespoke panel | Dialog |
|---|---|---|---|---|---|
| Planning Center | `planning-center` | lineup | **4** (2 text/pw, 2 select) | — | default |
| ProdCom | `prodcom` | lineup | **3** | `CaptionColorsPanel` (collapsed, ~28px) | default |
| ProPresenter | `propresenter` | control | **4** | `ProPresenterInstancesPanel` | **wide** |
| Smaart | `smaart` | control | **3** | — | default |
| SenSource Vea | `sensource` | control | **4** | `SenSourceScopePicker` (self-bounded `max-h-48`) | default |
| Wireless Gear | `wireless` | wireless | **0** | `WirelessConnectionsPanel` | **wide** |
| Resi | `resi` | control | **3** | — | default |
| YouTube | `youtube` | control | **6 declared, 3 visible** (`showIf` on `mode`) | — | default |
| OBS Studio | `obs` | control | **3** | — | default |
| REAPER | `reaper` | control | **2** | — | default |
| ProVideoPlayer | `pvp` | control | **4** | — | default |
| OSC | `osc` | control | **0** | `OscTargetsPanel` | **wide** |
| RossTalk | `rosstalk` | control | **0** | `RossTalkTargetsPanel` | **wide** |
| Ross MultiViewer | `ross-tsl` | control | **2** | `RossTslFeedsPanel` | **wide** |
| Live scores | `scores` | control | **0** | `ScoresTeamsPanel` (picker portals out) | default |
| Bitfocus Companion | `companion` | control, **inbound** | **0** | `CompanionInfoPanel` (read-only) | default |

Totals: 13 `control`, 2 `lineup`, 1 `wireless`. Eleven have four or fewer schema
fields and nothing else. Five carry a repeater panel.

### The one thing that constrains the dialog

The repeater panels have a single inline row that cannot wrap without looking
broken. Measured widest unbreakable row:

| Panel | Needs | The row |
|---|---|---|
| `RossTslFeedsPanel` | **~620px** | metric + zone + TSL # + prefix + suffix |
| `WirelessConnectionsPanel` | **~560px** | name + provider + host + status + switch + delete |
| `RossTalkTargetsPanel` | **~560px** | host + port + device + test |
| `OscTargetsPanel` | **~520px** | host + port, then subscribe address + interval |
| `ProPresenterInstancesPanel` | **~520px** | per-instance four-field form |

`DialogContent` is `max-w-lg` (512px, so ~464px of content after `p-6`). **That
is too narrow for all five.** This is the one real change the dialog forces, and
it is a className, not a new component — see Task 3.

---

## Decisions

### 1. Save semantics: explicit Save. That is not a change.

The premise that the inline form "persists as you go" is wrong. `IntegrationCard`
already compares against the saved config and shows `UnsavedBanner` with
Save / Discard (`integrations-panel.tsx:223`, `:456-463`); nothing writes until
Save. Moving it into a dialog changes the container, not the contract.

What *is* immediate today, and stays immediate:

- the **enable switch** — `integrations:setEnabled` fires on flick,
- the **targets/connections panels** (`wireless`, `osc`, `rosstalk`) — they
  auto-save their own list,
- `RossTslFeedsPanel` and `ProPresenterInstancesPanel` keep their own explicit
  "Save feeds" / "Save instances" buttons.

**Dismissing with unsaved changes never discards silently.** Escape, the close
button, and a click outside all route through one handler that raises the
existing `UnsavedChangesDialog` (`renderer/editor/unsaved-changes-dialog.tsx`) —
Keep editing / Discard / Save & close. That component already carries the rule
in its own comment: *"A dismissed dialog must never be read as consent to throw
work away."* Reuse it; do not write a second one.

The same file also settles why Save must be explicit here, for the same reason
the screen-URL dialog gives (`screen-urls-dialog.tsx:1-11`): closing a dialog
blurs the field, so a blur-save races the unmount, and a value the **server
refused** would look accepted because the dialog is already gone. Integrations
saves can fail — a bad credential comes back as a rejected promise — so the
refusal has to stay on screen.

### 2. The switch lives on the card *and* in the dialog header

Both, because they answer different questions. On the card it is "turn this off,
I am not using it today", without opening anything. In the dialog it is "I have
just typed my credentials, now switch it on".

The sequence that used to lose data:

> today — type a host into a dormant integration, flip its switch, and the card
> remounts into a different group; everything typed goes with it.

That is why `integrationDrafts` (a module-level draft store), `takeFocus`,
`noteFocus`, the `data-config-field` focus markers and the `preventScroll` FLIP
dance exist — `integrations-panel.tsx:204-262`, ~80 lines.

**With a dialog, that path stops existing.** The form renders in a portal, not
inside the card. When the grid reflows behind it, the dialog is not remounted,
so there is nothing to preserve and nothing to re-focus. The bug class is
removed structurally rather than patched.

The two orderings, stated:

- **Switch flicked on the card** (dialog closed) — the card animates from
  "Not set up" up to its group. Nothing is being typed, so nothing can be lost.
- **Switch flicked in the dialog header** — the grid behind reflows; the dialog
  does not move and keeps every unsaved edit. On close, the card is already in
  its new group.
- **Save then close** — save first, then the card moves, then focus returns.

Can the old problem recur? Only if the dialog is rendered from inside the tile,
so that a tile unmount takes the dialog with it. Task 5 makes that structurally
impossible (the dialog is a sibling of the grid, keyed by id) and Task 10 guards
it with a test that fails if the dialog is moved back inside the tile.

### 3. `useRevealNonce` is simplified, not deleted

Today a reveal has to punch through **two** collapsed layers — the "Not set up"
group, then the card's own `Collapsible` — because `data-flash-id` sits on the
config form *inside* the collapsed body (`integrations-panel.tsx:358`). Hence two
separate `useRevealNonce` call sites (`:1148` per card, `:1243` for the group).

After this change:

- `data-flash-id` moves onto the **card tile**, which is always in the DOM when
  its group is open. So the highlight has something to land on without any
  remount trick.
- The **per-card** `useRevealNonce` goes away — there is no `Collapsible` per
  card any more.
- The **panel-level** one stays, in simplified form: it still has to open the
  "Not set up" section when the target is inside it. It is the only collapsible
  left.
- A reveal additionally **opens that integration's dialog**, which is what the
  operator wanted in the first place.

Three call sites aim at the literal `"pco-credentials"` — `settings/getting-started.tsx:39-46`,
`app/home/readiness.ts:68-76`, and the popover's derived path via
`integrationFlashId`. Only the last is type-linked to `FLASH_IDS`. Task 9 adds a
test that pins all three.

### 4. Deep-linking: a search param, and Back closes the dialog

`/settings/integrations?integration=obs`. The open dialog is URL state, so the
browser Back button closes it, a link can be handed to someone, and a reload
comes back to the same place. On a wall-mounted console Back is often the only
navigation available, and a Back that leaves the page instead of closing the
dialog is the wrong answer.

This is the last task and is independently droppable — everything before it works
with plain `useState`.

Router gotcha, already documented in `renderer/app/router.tsx`: this router does
**not** declare the `Register` module augmentation (the kiosk router claims it),
so `navigate({ to })` is not narrowed and needs `as never` in places — see
`app/screens/screens-route.tsx:51` for the existing precedent.

### 5. Phone: a full-screen sheet

A centred `max-w-2xl` modal on a 390px phone is a modal with 16px of margin,
which is a bad full-screen sheet pretending to be a dialog. Under `sm` the same
`DialogContent` takes a className that makes it `inset-0`, full height, square
corners, with a sticky footer. No new primitive — `DialogContent` merges
classNames through `cn`, and the responsive variant is one string.

Verified in the mockup at 320px and 390px: true full-screen, fields stack, every
control goes full width, the action row stays on screen, and nothing overflows
horizontally.

### 6. Focus and dismissal

Radix `Dialog` gives the focus trap, the initial focus, `Escape`, and
return-focus-to-trigger for free. One real trap, found by building it:

> **Radix returns focus to the trigger *node*. Saving can move that card into a
> different group, which unmounts the node — and focus falls to `<body>`.**

The mockup hit exactly this and reported `focusReturnedToCard: false` until the
fix: remember the integration **id**, and on close focus
`[data-integration-card="<id>"]` looked up fresh. Task 8 does this and ships the
failing-first test.

Dismissal, all three routes, one handler:

| Gesture | Clean | Dirty |
|---|---|---|
| `Escape` | closes | raises `UnsavedChangesDialog` |
| Close button / X | closes | raises `UnsavedChangesDialog` |
| Click outside | closes | raises `UnsavedChangesDialog` |

### Is the dialog wrong for any of the sixteen?

No — but two are worth naming rather than discovering later.

- **Wireless Gear is the tightest fit.** Four receivers is ~830px of content in a
  768px-wide dialog whose body scrolls. It fits (verified: 737x541 at 1400x920,
  no inner scroll needed). It is the one that would outgrow the dialog first; if
  it gains another inline column it wants its own page, and that is a later
  decision, not this one.
- **Two nested-overlay cases need a test, not a redesign.** `ScoresTeamsPanel`'s
  `TeamPicker` is a Radix Popover *inside* a Radix Dialog, and
  `SenSourceScopePicker` puts a `max-h-48` scroll inside the dialog's scroll.
  Both work in Radix; both are the kind of thing that silently breaks. Task 7
  covers them.

Everything else is four fields or fewer and is comfortable.

---

## The file split

`integrations-panel.tsx` is 1470 lines. The seam is already drawn — three bespoke
panels sit contiguous at **511-1012** (500 lines, 34%) with no interleaving, each
taking only `{ state, onStateChange }`:

| Extract to | From | Lines |
|---|---|---|
| `renderer/components/sensource-scope-picker.tsx` | 511-713 | 203 |
| `renderer/components/ross-tsl-feeds-panel.tsx` | 715-829 | 115 |
| `renderer/components/propresenter-instances-panel.tsx` | 831-1012 | 182 |

This serves the change rather than tidying for its own sake: the dialog body is
assembled from these, and five of the eight panels already live in their own
files, so the current arrangement is the outlier.

Three things travel with it:

1. `ConnectionBadge` (108-156) is the one true cross-bucket dependency —
   `InstanceStatusBadge` uses it at :853. It moves to
   `renderer/components/connection-badge.tsx`.
2. `IpListField` (58-106) is **already duplicated** verbatim in
   `wireless-connections-panel.tsx:58-106`. Two copies; both change to import one.
3. `feedId()` (727-731) is used by *both* `RossTslFeedsPanel` and
   `ProPresenterInstancesPanel` (:906), so it goes to a shared helper, not with
   one panel.

Result: ~970 lines before the redesign removes the ~80 lines of draft machinery.

---

## Tasks

Each task is a commit. Tests first, and each guard is proved by watching it fail.

### Task 1 — Extract `ConnectionBadge` and dedupe `IpListField`

Pure move, no behaviour change. Do it first so the later diffs are small.

1. New `renderer/components/connection-badge.tsx` holding `ConnectionBadge`
   verbatim from `integrations-panel.tsx:102-156`.
2. New `renderer/components/ip-list-field.tsx` holding `IpListField` from
   `integrations-panel.tsx:58-106`.
3. Delete **both** copies of `IpListField` — `integrations-panel.tsx:58-106` and
   `wireless-connections-panel.tsx:58-106` — and import the shared one in both.
   Grep first: `grep -rn "function IpListField" renderer/` must return 0 after.
4. Import `ConnectionBadge` in `integrations-panel.tsx` and
   `wireless-connections-panel.tsx`.

Verify: `npm run type-check` and `npm test` green; the commit message says
"2 copies of IpListField found, 2 removed".

### Task 2 — Extract the three bespoke panels

Move 511-1012 into the three files above, plus `feedId()` into
`renderer/components/integration-panel-helpers.ts`. Imports only; no logic edits.

Verify: `npm run type-check`; `wc -l renderer/components/integrations-panel.tsx`
is ~970.

### Task 3 — A wide variant for `DialogContent`

The only primitive change. `DialogContent` already merges className through `cn`,
so this is a call-site string plus one shared constant so the five wide dialogs
cannot drift:

```ts
// renderer/components/integration-dialog-size.ts

/** Integrations whose body holds a repeater whose widest row cannot wrap.
 *  Measured off the running app: ross-tsl needs ~620px, wireless and rosstalk
 *  ~560px, osc and propresenter ~520px. DialogContent's default max-w-lg gives
 *  ~464px of content, which is too narrow for every one of them. */
export const WIDE_DIALOG_IDS = new Set([
  "wireless", "osc", "rosstalk", "ross-tsl", "propresenter",
]);

/** max-w-3xl = 768px (~720px of content) for the five; max-w-2xl = 672px
 *  (~624px) for the rest. Plus the phone sheet, and a body that scrolls rather
 *  than a dialog that grows past the viewport. */
export function integrationDialogClass(id: string): string {
  return cn(
    "flex flex-col max-h-[86vh] p-0",
    WIDE_DIALOG_IDS.has(id) ? "max-w-3xl" : "max-w-2xl",
    // Phone: a full-screen sheet, not a modal with 16px of margin.
    "max-sm:inset-0 max-sm:left-0 max-sm:top-0 max-sm:h-full max-sm:max-h-none",
    "max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0",
    "max-sm:rounded-none max-sm:border-0",
  );
}
```

**Test** `renderer/components/integration-dialog-size.test.ts` — assert an EXACT
set, not a floor, and derive the expectation from the descriptors rather than
restating the literal:

```ts
// Every integration that renders a repeater panel must be in WIDE_DIALOG_IDS.
// An exact equality, because a floor is how a new repeater integration would
// ship in a 672px dialog with its rows wrapping and nobody noticing.
const REPEATER_PANEL_IDS = new Set(["wireless", "osc", "rosstalk", "ross-tsl", "propresenter"]);
assert.deepEqual([...WIDE_DIALOG_IDS].sort(), [...REPEATER_PANEL_IDS].sort());
```

Prove it: delete `"ross-tsl"` from `WIDE_DIALOG_IDS`, watch it go red, put it
back. Say so in the commit.

### Task 4 — The card tile

Replace `IntegrationRow` / `IntegrationEntry` with a tile. No `Collapsible`, no
body.

```tsx
/** One integration as a card. It is a summary and a button: name, what it is
 *  pointed at, its connection, and an enable switch. Settings open in a dialog
 *  — the card never holds a form, which is what lets the grid stay a grid. */
function IntegrationTile({ descriptor, state, onOpen, onToggle, toggling }: {...}) {
  const dormant = !isInUse(state);
  return (
    <div
      role="button"
      tabIndex={0}
      // The flash target is the TILE, not the form. The form is in a portal and
      // is not in the DOM until the dialog opens, so a highlight aimed at it
      // would land on nothing — which is the bug useRevealNonce existed to work
      // around.
      data-flash-id={integrationFlashId(descriptor.id)}
      data-integration-card={descriptor.id}
      data-slide-id={descriptor.id}
      onClick={() => onOpen(descriptor.id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(descriptor.id); } }}
      aria-haspopup="dialog"
      aria-label={`${descriptor.label} settings`}
      className={cn(
        "su-card flex flex-col gap-1.5 px-3 py-2.5 min-h-24 text-left cursor-pointer",
        "hover:border-line-strong transition-colors",
        dormant && "bg-transparent border-dashed shadow-none min-h-[4.5rem]",
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn("flex-1 min-w-0 text-callout truncate",
          dormant ? "font-medium text-fg-muted" : "font-semibold text-fg")}>
          {descriptor.label}
        </span>
        {/* No switch for an integration that dials US. */}
        {!descriptor.inbound && (
          <Switch
            checked={state.enabled}
            disabled={toggling}
            aria-label={`Enable ${descriptor.label}`}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            onCheckedChange={(v: boolean) => onToggle(descriptor.id, v)}
          />
        )}
      </div>
      <span className="text-caption1 text-fg-subtle truncate">{summaryLine(descriptor, state)}</span>
      <div className="mt-auto">
        <ConnectionBadge connection={state.connection} message={state.message} inbound={descriptor.inbound} />
      </div>
    </div>
  );
}
```

`summaryLine()` is new and small: the host:port the integration is pointed at
when configured, otherwise a short phrase from the descriptor. It is what makes
a tile worth more than a row — the grid gives vertical room a row never had.

Grid, per group: `grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(15.75rem,1fr))]`.

**Test** `renderer/components/integration-tile.test.tsx`:

- an `inbound` descriptor renders **no** `Switch` (prove it: drop the
  `!descriptor.inbound` guard, watch it go red),
- clicking the switch does **not** open the dialog (`stopPropagation`),
- every descriptor's tile carries `data-flash-id` equal to
  `integrationFlashId(id)` — iterate `INTEGRATION_DESCRIPTORS`, assert a count of
  16, not a floor.

### Task 5 — The dialog

One dialog, rendered by `IntegrationsPanel` as a **sibling of the grid**, keyed by
id. Not inside the tile — that is the invariant that keeps the draft-loss bug
gone.

```tsx
// Rendered here, next to the grid, rather than inside the tile. A dialog owned
// by a tile is unmounted when that tile moves between groups — which is exactly
// what enabling an integration does, and exactly how everything typed used to be
// lost. In a portal beside the grid it does not care what the grid does.
{openId && (
  <IntegrationDialog
    key={openId}
    descriptor={byId.get(openId)!}
    state={stateMap.get(openId)!}
    onStateChange={handleStateChange}
    onClose={() => setOpenId(null)}
  />
)}
```

`IntegrationDialog` composes `DialogRoot` + `DialogContent` (not the high-level
`Dialog`, which always closes on confirm — its own comment says that suits a
confirmation and nothing else):

```tsx
<DialogRoot open onOpenChange={(next) => { if (!next) requestClose(); }}>
  <DialogContent className={integrationDialogClass(descriptor.id)}>
    <DialogHeader className="px-5 pt-4 pb-3 border-b border-line mb-0 flex-row items-start gap-3">
      <div className="min-w-0">
        <DialogTitle>{descriptor.label}</DialogTitle>
        {descriptor.description && <DialogDescription>{descriptor.description}</DialogDescription>}
      </div>
      <div className="ml-auto flex items-center gap-3 shrink-0">
        <ConnectionBadge connection={state.connection} message={state.message} inbound={descriptor.inbound} />
        {!descriptor.inbound && <Switch checked={state.enabled} onCheckedChange={toggleEnabled} aria-label={`Enable ${descriptor.label}`} />}
      </div>
    </DialogHeader>
    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">{body}</div>
    {!descriptor.inbound && <DialogFooter className="px-5 py-3 border-t border-line mt-0">{actions}</DialogFooter>}
  </DialogContent>
</DialogRoot>
```

`body` is exactly today's `bodyFor()`, unchanged. `actions` is today's actions row
(Test connection, Refresh now + synced label for PCO, Clear transcript for
ProdCom) plus Save / Discard, replacing the floating `UnsavedBanner`.

`IntegrationCard` keeps its schema-driven form and its `dirty` comparison and
loses the draft store, `takeFocus`/`noteFocus`, the focus effect and the
`data-config-field` markers — around 80 lines. It reports `dirty` upward so the
dialog can guard its own dismissal.

### Task 6 — Guarded dismissal

```tsx
function requestClose() {
  // Escape, the X, and a click outside all arrive here. A dismissed dialog is
  // never consent to throw work away.
  if (dirty) { setConfirming(true); return; }
  onClose();
}
```

and on confirm, the existing component:

```tsx
<UnsavedChangesDialog
  open={confirming}
  saving={isSaving}
  description={`Your changes to ${descriptor.label} have not been saved.`}
  saveLabel="Save & close"
  onCancel={() => setConfirming(false)}
  onDiscard={() => { setConfirming(false); onClose(); }}
  onSave={async () => { await handleSave(); setConfirming(false); onClose(); }}
/>
```

**Test** `renderer/components/integration-dialog-dismiss.test.tsx`, driving the
real component:

- edit a field, press Escape -> `UnsavedChangesDialog` is shown and `onClose` was
  **not** called,
- Keep editing -> back to the form, edit still there,
- Discard -> `onClose` called, no save IPC fired,
- Save & close -> save IPC fired, then `onClose`,
- clean dialog + Escape -> closes with no confirm.

Prove it: make `requestClose` call `onClose()` unconditionally and watch the
first case go red.

### Task 7 — The two nested-overlay cases

**Test** `renderer/components/integration-dialog-overlays.test.tsx`:

- open the `scores` dialog, open `TeamPicker`, assert its content is in the
  document and that a click inside it does **not** dismiss the dialog (a popover
  inside a Radix dialog counts as "outside" if it is not marked as nested),
- open the `sensource` dialog and assert the zone list keeps its own bounded
  scroll (`max-h-48`) rather than stretching the dialog body.

These are guards over the real code path, not over source text.

### Task 8 — Focus returns to the card that opened it

```tsx
// Radix returns focus to the trigger NODE, and saving can move that card into a
// different group, which unmounts it — so focus lands on <body> and the operator
// is nowhere. Remember the id and look the card up fresh instead.
const returnTo = useRef<string | null>(null);
// ...on close:
const el = document.querySelector<HTMLElement>(`[data-integration-card="${id}"]`);
el?.focus({ preventScroll: true });
```

**Test** `renderer/components/integration-dialog-focus.test.tsx`: open the dialog
for a dormant integration, enable it, save, close — assert
`document.activeElement` is the card, which has by then moved groups. Prove it by
holding the node instead of the id and watching it fail.

### Task 9 — Reveal opens the dialog

`integrationFlashId` and `FLASH_IDS` are unchanged. The panel's `useRevealNonce`
now also sets `openId`.

```tsx
// A reveal names one integration. Open its dialog and highlight its card: the
// operator clicked "2 disconnected" to DO something about it.
useRevealTarget((flashId) => {
  const hit = descriptors.find((d) => integrationFlashId(d.id) === flashId);
  if (!hit) return;
  if (!isInUse(stateMap.get(hit.id)!)) setDormantOpen(true);
  setOpenId(hit.id);
});
```

**Test** `renderer/components/integration-reveal.test.tsx`:

- `flashTarget(integrationFlashId("obs"))` opens the OBS dialog,
- `flashTarget("pco-credentials")` opens the Planning Center dialog — the literal,
  because three call sites hardcode it,
- a reveal aimed at a dormant integration expands "Not set up" as well.

Plus a scan that pins the three call sites, matching on the assignment rather
than the bare string so a comment cannot satisfy it:

```ts
// getting-started.tsx and readiness.ts both hardcode "pco-credentials" rather
// than calling integrationFlashId("planning-center"). Assert the value each one
// actually assigns, so deleting the line fails the test.
assert.equal(GETTING_STARTED_STEPS.find((s) => s.label === "Connect Planning Center")?.flash, "pco-credentials");
assert.equal(readinessChecks(stateFixture).find((c) => c.id === "pco")?.flash, "pco-credentials");
assert.equal(integrationFlashId("planning-center"), "pco-credentials");
```

### Task 10 — The dialog is not owned by a tile

The invariant that keeps the old data-loss bug dead.

**Test** `renderer/components/integration-draft-survives-move.test.tsx` — the file
already exists for the old mechanism; repoint it:

- open a dormant integration's dialog, type a host, flip the switch in the dialog
  header so the card moves groups, assert the typed value is **still in the
  field** and the dialog is still open.

Prove it by rendering the dialog from inside `IntegrationTile` and watching it go
red.

### Task 11 — FLIP across the grid

`useSlideOnMove` needs no change: it is a full 2D FLIP on `getBoundingClientRect`,
and Home already uses it for widgets moving between **grid cells**
(`app/home/home-grid.tsx:246`). Keep `data-slide-id` and the existing
`moveSignature`; keep `capture()` as `onBeforeMove` on the toggle.

Two known limits to state in the commit rather than discover: it animates
position only, not size, and it does nothing for enter/exit. Tiles are uniform,
so neither bites here.

**Test**: the existing signature test still passes; add one asserting the
signature changes when and only when an integration crosses between dormant and a
group.

### Task 12 — `PAIRS` retires

`PAIRS` (`:1061`) exists so RossTalk and Ross MultiViewer do not read as two
full-width rows of clutter. In a grid they are two small tiles adjacent in
"Control & output", which is the same grouping the pair card was faking.
`IntegrationPairRow` (46 lines) and the anchor logic in the render go.

Stated as a removal with a reason, not a silent drop: the presentation problem it
solved does not exist in a grid, and each id already kept its own enable flag,
config and connection state, so nothing else referenced the pairing.

### Task 13 — Deep link (independently droppable)

`?integration=<id>` on `/settings/integrations`, replacing the `useState`.
Back closes the dialog; a reload reopens it; an unknown id is ignored.

**Test**: navigating with `?integration=obs` opens the OBS dialog; an unknown id
renders the grid with no dialog and does not throw.

---

## Feature parity inventory

Nothing is dropped without a stated reason.

| # | Behaviour today | After |
|---|---|---|
| 1 | Enabling a dormant integration animates it to its group | **Preserved** — Task 11, same `useSlideOnMove`, same `data-slide-id`, 2D FLIP as Home already does across grid cells |
| 2 | ...keeping typed-but-unsaved data | **Preserved structurally** — Task 5/10. The form is in a portal beside the grid, so the move cannot unmount it |
| 3 | ...keeping the operator's focus | **Preserved structurally** — same reason. Focus never leaves the dialog because the dialog never remounts |
| 4 | `integrationDrafts` store, `takeFocus`/`noteFocus` | **Removed, with reason** — they existed only to survive a remount that no longer happens. Task 10 guards that it cannot come back |
| 5 | Context bar "N disconnected" reveals one integration | **Preserved and improved** — Task 9. Flash lands on the tile and the dialog opens |
| 6 | Getting Started points at the PCO card | **Preserved** — Task 9; `"pco-credentials"` unchanged, all three call sites pinned by test |
| 7 | Per-card `useRevealNonce` + `defaultOpen` remount | **Removed, with reason** — it existed because the target was inside a collapsed body. The tile is always in the DOM |
| 8 | Panel-level `useRevealNonce` for "Not set up" | **Preserved** — the section is still collapsible |
| 9 | An `inbound` integration gets no switch | **Preserved** — Task 4 (card) and Task 5 (dialog header); tested both places |
| 10 | `ConnectionBadge` states and colours | **Preserved** — moved verbatim in Task 1, used on the tile and in the dialog header |
| 11 | Error message truncates with full text on hover | **Preserved** — same component; the tile is narrower, so `min-w-0 truncate` matters more, and the `Tooltip` still carries the full text |
| 12 | Explicit Save / Discard on the schema form | **Preserved** — moves from floating `UnsavedBanner` to the dialog footer |
| 13 | Save failure stays on screen | **Preserved** — Task 6; dialog does not close until the save resolves |
| 14 | Test connection, and its result line | **Preserved** — dialog footer |
| 15 | PCO "Refresh now" + "Synced HH:MM" | **Preserved** — dialog footer |
| 16 | ProdCom "Clear transcript" | **Preserved** — dialog footer |
| 17 | `showIf` conditional fields (YouTube) | **Preserved** — untouched in `IntegrationCard` |
| 18 | Password masking and omit-on-save | **Preserved** — untouched |
| 19 | All 8 bespoke panels | **Preserved** — same components, rendered in the dialog body; 3 move to their own files |
| 20 | `CaptionColorsPanel` under ProdCom | **Preserved** — still additive after the schema form |
| 21 | Category grouping + "Other" bucket | **Preserved** — groups become grid sections |
| 22 | "Not set up (N)" collapsed at the bottom | **Preserved** — the operator's stated ask; already built, kept as-is |
| 23 | Dormant greyed-out treatment | **New** — the operator asked for it; dashed border, no shadow, muted label |
| 24 | Summary strip "N connected / M to set up" | **Preserved** — unchanged |
| 25 | `PAIRS` (Ross shown as one card) | **Removed, with reason** — Task 12; adjacency in the grid replaces it |
| 26 | Live SSE state updates | **Preserved** — untouched; the open dialog re-renders from the same query data |
| 27 | Loading skeleton and error state | **Preserved** — untouched |
| 28 | `IpListField` | **Preserved** — deduped to one copy (Task 1) |

Not in scope, noted rather than changed: `.score-*`, `score-activity.tsx`,
`.context-strip`, the bar configurator, the app-shell scroll, the editor canvas.
The shell owns the page scroller and the horizontal gutter
(`app/shell.tsx`, `px-5 max-sm:px-3`); this plan does not touch it.

---

## Verify before claiming

- `npm run type-check`, `npm run lint`, `npm test` green.
- Drive the real server: card grid renders 16 tiles; open a small one (REAPER)
  and a repeater one (Wireless); type, Escape, check the confirm; Discard, then
  Save & close; flip a dormant switch and watch it move; click "N disconnected"
  in the context bar and land on the right open dialog; repeat at 390px.
- Each guard proved by watching it fail, said so in its commit.

## Docs

One file describes the page: `docs/integrations/README.md` says each integration
is "configured under **Settings → Integrations**, where each shows its own
connection state". That stays true of a card grid, so **no docs change is
needed** — checked rather than assumed. Nothing else in `docs/` describes the
page's shape.

No new log lines. This is renderer-only and adds no path that can fail silently;
the save and test-connection paths already log and toast, and the dismissal guard
surfaces failure to the operator rather than swallowing it.
