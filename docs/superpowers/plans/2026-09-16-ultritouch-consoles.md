# Ultritouch Consoles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Stage Utility console runs on a Ross Ultritouch at the panel's exact pixels, with a new cue button that fires a cue and shows its live state.

**Architecture:** Three Ultritouch canvas presets lock Letterbox fit in the layout editor. A new `cue-button` layout object reads the cue manifest and live cue state over a new `cues:all` event channel and fires through `POST /api/cues/<name>`, which learns to accept a same-origin browser. Strip starter templates and a docs page finish it. Nothing changes for the Home Assistant consumer of the existing `cues` channel.

**Tech Stack:** TypeScript, Node 24 `node:test` (`node --import tsx --test <file>`), React 18 with `@testing-library/react` under `installDom()`, plain HTTP routes in `main/services/routes`.

**Spec:** `docs/superpowers/specs/2026-09-16-ultritouch-consoles-design.md`

## Global Constraints

- Every change is a PR off `beta`; never commit on `beta`. Commit per task, do not push; the parent session pushes.
- Commit subjects are `type(scope): subject`, no emojis, no attribution footer, no literal breaking-change phrase in a body.
- A guard must be shown red first: run the new test before the implementation and record the failure in the commit body.
- Exact counts, never floors: `object-capabilities.test.ts` and `object-catalog.test.ts` both pin 61 object types and move to **62**.
- `Beta-only: true` is not carried by any commit here: nothing fixes a bug, everything is new.
- Never contact a real device. No test may reach Companion (192.168.16.58), prod (192.168.16.61) or any other LAN host. Stub `cueLiveDeps`, `cueManifestDeps` and `cueButtonDeps`.
- Docs ship in the same commit as the code they describe, in the voice already in `docs/`.
- Formatting: do not run `oxfmt` over whole files; the repo has no config and the defaults reflow existing lines. Match surrounding style by hand.

## File map

| File | Responsibility |
|---|---|
| `renderer/editor/layout-templates.ts` | `ULTRITOUCH_PRESETS`, `isUltritouchCanvas`, `ultritouchTemplate` |
| `renderer/editor/layout-editor.tsx` | preset click sets `fit: "contain"`; fit buttons disabled on an Ultritouch canvas |
| `renderer/settings/sections/view-detail.tsx` | preview shapes gain the three panels |
| `renderer/settings/sections/new-view-dialog.tsx` | starters gain the three strips |
| `main/services/cue-manifest.ts` | `cueManifest({ includeHidden })` |
| `main/services/cue-live.ts` | `cues:all` channel beside `cues` |
| `main/services/routes/cue-routes.ts` | `?all=1` on the manifest; same-origin browser may call a cue |
| `main/types/views.ts` | `cue-button` config in `LayoutObjectConfig` |
| `main/types/object-capabilities.ts` | `"cue-button": ["control"]` |
| `renderer/main/layout-objects.ts` | palette spec for `cue-button` |
| `renderer/editor/palette.tsx` | icon |
| `renderer/editor/inspector.tsx` | cue picker, label, show-device |
| `renderer/main/use-cue-live.ts` | `useCueLive(enabled)` hook |
| `renderer/main/cue-button.tsx` | the component and `cueButtonDeps` |
| `renderer/main/layout-renderer.tsx` | ctx gains `cues`; `case "cue-button"` |
| `renderer/main/test-render-ctx.ts` | `cues: null` default |
| `renderer/lib/api.ts` | `cues:manifest`, `cues:call` invoke cases |
| `docs/reference/layout-editor.md`, `docs/reference/widgets.md`, `docs/reference/api.md`, `SECURITY.md`, `docs/integrations/ultritouch.md`, `docs/integrations/README.md`, `docs/features/operator-app.md` | docs |

Three PRs: **A** (Tasks 1–2, presets and fit), **B** (Tasks 3–9, the cue button end to end), **C** (Tasks 10–11, templates and the Ultritouch page). A depends on nothing; C depends on A and B.

---

## PR A: presets and locked fit

### Task 1: Ultritouch canvas presets

**Files:**
- Modify: `renderer/editor/layout-templates.ts:147-160`
- Modify: `renderer/settings/sections/view-detail.tsx:34-39`
- Test: `renderer/editor/layout-templates.test.ts` (create)

**Interfaces:**
- Produces: `export const ULTRITOUCH_PRESETS: { id: "ultritouch-2" | "ultritouch-2-hr" | "ultritouch-4"; label: string; w: number; h: number }[]`, `export function isUltritouchCanvas(w: number, h: number): boolean`. `CANVAS_PRESETS` now ends with the three Ultritouch entries.

- [ ] **Step 1: Write the failing test**

```ts
// renderer/editor/layout-templates.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { CANVAS_PRESETS, ULTRITOUCH_PRESETS, isUltritouchCanvas } from "./layout-templates.js";

describe("Ultritouch canvas presets", () => {
  test("the three panels, at the User Guide's pixels", () => {
    // Ultritouch User Guide 2201DR-304, Table 1. Exact, not approximate: the
    // browser component is drawn edge to edge and a preset a few pixels off
    // letterboxes a sliver on the panel itself.
    assert.deepEqual(
      ULTRITOUCH_PRESETS.map((p) => [p.id, p.w, p.h]),
      [
        ["ultritouch-2", 1366, 203],
        ["ultritouch-2-hr", 1920, 285],
        ["ultritouch-4", 1366, 485],
      ],
    );
  });

  test("they are on the Canvas popover's list, after the screen shapes", () => {
    const tail = CANVAS_PRESETS.slice(-3).map((p) => p.id);
    assert.deepEqual(tail, ["ultritouch-2", "ultritouch-2-hr", "ultritouch-4"]);
    // Exact: a preset added by hand later must land here on purpose.
    assert.equal(CANVAS_PRESETS.length, 12);
  });

  test("a canvas is recognised by its pixels, not a flag", () => {
    // A layout imported from another install carries no marker, only numbers.
    assert.equal(isUltritouchCanvas(1366, 203), true);
    assert.equal(isUltritouchCanvas(1920, 285), true);
    assert.equal(isUltritouchCanvas(1366, 485), true);
    assert.equal(isUltritouchCanvas(1920, 1080), false);
    assert.equal(isUltritouchCanvas(1366, 204), false);
  });
});
```

- [ ] **Step 2: Run it, expect red**

```bash
node --import tsx --test renderer/editor/layout-templates.test.ts
```
Expected: FAIL, `ULTRITOUCH_PRESETS` is not exported.

- [ ] **Step 3: Implement**

In `renderer/editor/layout-templates.ts`, replace the `CANVAS_PRESETS` block (lines 147–160) with:

```ts
// Canvas aspect presets. Resolution is irrelevant for a screen (the renderer
// scales the design canvas to fit any screen, incl. 4K) — only the aspect and
// orientation matter. The Ultritouch entries are the exception: they ARE
// pixel sizes, because the panel's browser frame is exactly that many pixels
// and the layout is letterboxed into it. See isUltritouchCanvas.
export type CanvasPreset = { id: string; label: string; w: number; h: number };

/**
 * The three Ross Ultritouch panels, from the Ultritouch User Guide
 * (2201DR-304, Table 1). Picking one locks Letterbox fit in the editor: a
 * control surface for a panel whose pixels are known has no reason to reflow.
 */
export const ULTRITOUCH_PRESETS: CanvasPreset[] = [
  { id: "ultritouch-2", label: "Ultritouch-2 · 1366 x 203", w: 1366, h: 203 },
  { id: "ultritouch-2-hr", label: "Ultritouch-2-HR · 1920 x 285", w: 1920, h: 285 },
  { id: "ultritouch-4", label: "Ultritouch-4 · 1366 x 485", w: 1366, h: 485 },
];

export const CANVAS_PRESETS: CanvasPreset[] = [
  { id: "16:9", label: "Landscape · 16:9", w: 1920, h: 1080 },
  { id: "9:16", label: "Portrait · 9:16", w: 1080, h: 1920 },
  { id: "4:3", label: "Standard · 4:3", w: 1440, h: 1080 },
  { id: "16:10", label: "Widescreen · 16:10", w: 1920, h: 1200 },
  { id: "21:9", label: "Ultrawide · 21:9", w: 2560, h: 1080 },
  { id: "32:9", label: "Super ultrawide · 32:9", w: 3840, h: 1080 },
  { id: "1:1", label: "Square · 1:1", w: 1080, h: 1080 },
  { id: "3:2", label: "3:2", w: 1620, h: 1080 },
  { id: "5:4", label: "5:4", w: 1350, h: 1080 },
  ...ULTRITOUCH_PRESETS,
];

/** True when a canvas is exactly one of the Ultritouch panels. By pixels, not a
 *  stored flag, so a layout imported from another install behaves the same. */
export function isUltritouchCanvas(w: number, h: number): boolean {
  return ULTRITOUCH_PRESETS.some((p) => p.w === w && p.h === h);
}
```

In `renderer/settings/sections/view-detail.tsx`, replace `PREVIEW_ASPECTS` (lines 34–39) with:

```ts
const PREVIEW_ASPECTS = [
  { id: "16:9", label: "16:9 · landscape", ratio: 16 / 9 },
  { id: "9:16", label: "9:16 · portrait", ratio: 9 / 16 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "21:9", label: "21:9 · ultrawide", ratio: 21 / 9 },
  { id: "ultritouch-2", label: "Ultritouch-2 · 1366 x 203", ratio: 1366 / 203 },
  { id: "ultritouch-2-hr", label: "Ultritouch-2-HR · 1920 x 285", ratio: 1920 / 285 },
  { id: "ultritouch-4", label: "Ultritouch-4 · 1366 x 485", ratio: 1366 / 485 },
];
```

- [ ] **Step 4: Run it, expect green; then typecheck**

```bash
node --import tsx --test renderer/editor/layout-templates.test.ts && npm run -s type-check
```

- [ ] **Step 5: Docs**

In `docs/reference/layout-editor.md`, replace the preset line under **Canvas shape** (lines 86–87) with:

```
Landscape 16:9 · Portrait 9:16 · Standard 4:3 · Widescreen 16:10 ·
Ultrawide 21:9 · Super ultrawide 32:9 · Square 1:1 · 3:2 · 5:4 ·
Ultritouch-2 1366 x 203 · Ultritouch-2-HR 1920 x 285 · Ultritouch-4 1366 x 485
```

and after the sentence ending "The **fit** below is chosen in the same popover." add:

```
The three Ultritouch presets are pixel sizes rather than shapes: a Ross
Ultritouch panel's browser frame is exactly that many pixels, and a layout for
it is letterboxed, never reflowed. See [Ultritouch](../integrations/ultritouch.md).
```

- [ ] **Step 6: Commit**

```bash
git add renderer/editor/layout-templates.ts renderer/editor/layout-templates.test.ts renderer/settings/sections/view-detail.tsx docs/reference/layout-editor.md
git commit -m "feat(layout-editor): canvas presets for the three Ross Ultritouch panels" -m "Pixel sizes from the Ultritouch User Guide (2201DR-304). Guard proven red: ULTRITOUCH_PRESETS was not exported and CANVAS_PRESETS had 9 entries."
```

### Task 2: An Ultritouch canvas locks Letterbox fit

**Files:**
- Modify: `renderer/editor/layout-editor.tsx:2137-2148` (preset buttons) and `:2163-2185` (fit buttons)
- Test: `renderer/editor/layout-editor-fit-lock.test.ts` (create)

**Interfaces:**
- Consumes: `isUltritouchCanvas` from Task 1.
- Produces: `export function canvasAfterPreset(canvas: LayoutCanvas, preset: { w: number; h: number }): LayoutCanvas` in `renderer/editor/layout-templates.ts` — pure, so the rule is testable without mounting the editor.

- [ ] **Step 1: Write the failing test**

```ts
// renderer/editor/layout-editor-fit-lock.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { canvasAfterPreset, ULTRITOUCH_PRESETS, CANVAS_PRESETS } from "./layout-templates.js";

describe("choosing a canvas preset", () => {
  test("an Ultritouch preset sets Letterbox fit", () => {
    const before = { width: 1920, height: 1080, background: null, fit: "responsive" as const };
    const after = canvasAfterPreset(before, ULTRITOUCH_PRESETS[0]!);
    assert.equal(after.width, 1366);
    assert.equal(after.height, 203);
    assert.equal(after.fit, "contain");
  });

  test("a screen preset leaves the fit alone", () => {
    // Nothing about a 16:9 wall says letterbox or responsive; the operator's
    // choice stands.
    const before = { width: 1366, height: 203, background: null, fit: "contain" as const };
    const after = canvasAfterPreset(before, CANVAS_PRESETS[0]!);
    assert.equal(after.fit, "contain");
    const before2 = { ...before, fit: "responsive" as const };
    assert.equal(canvasAfterPreset(before2, CANVAS_PRESETS[0]!).fit, "responsive");
  });
});
```

- [ ] **Step 2: Run it, expect red**

```bash
node --import tsx --test renderer/editor/layout-editor-fit-lock.test.ts
```
Expected: FAIL, `canvasAfterPreset` is not exported.

- [ ] **Step 3: Implement the pure rule**

Append to `renderer/editor/layout-templates.ts`:

```ts
import type { LayoutCanvas } from "@main/types/views";

/**
 * The canvas after a preset is chosen. An Ultritouch preset also sets Letterbox
 * fit: the panel's pixels are known and a reflowed strip is what turned a wall
 * layout into a stack of unreadable labels. Any other preset changes only the
 * shape and leaves the operator's fit where it was.
 */
export function canvasAfterPreset(canvas: LayoutCanvas, preset: { w: number; h: number }): LayoutCanvas {
  const next: LayoutCanvas = { ...canvas, width: preset.w, height: preset.h };
  if (isUltritouchCanvas(preset.w, preset.h)) next.fit = "contain";
  return next;
}
```

(Move the `import type` to the top of the file with the other imports.)

- [ ] **Step 4: Wire the editor**

In `renderer/editor/layout-editor.tsx` line 104, add `isUltritouchCanvas, canvasAfterPreset` to the import from `./layout-templates`.

Replace the preset button's `onClick` (line ~2144):

```tsx
onClick={() => { setCanvas(canvasAfterPreset(canvas, p)); setDirty(true); }}
```

Above the `<ButtonGroup>` for fit (line ~2163) add:

```tsx
{/* Locked on an Ultritouch canvas: the panel's pixels are known, so the
    layout keeps its shape and scales evenly. See canvasAfterPreset. */}
```

and give both fit `<Button>`s `disabled={isUltritouchCanvas(canvas.width, canvas.height)}`. Change the Letterbox tooltip to end with `Right for a wall screen, and locked on for an Ultritouch panel.`

- [ ] **Step 5: Run the test, typecheck, lint**

```bash
node --import tsx --test renderer/editor/layout-editor-fit-lock.test.ts && npm run -s type-check && npm run -s lint
```

- [ ] **Step 6: Drive the real editor**

Start a test server on an EMPTY data dir (never a copy of `~/.stage-utility`: a copy dials the Shure receivers, Planning Center and Vea regardless of integration flags; never port 8788):

```bash
mkdir -p /tmp/su-ultritouch && STAGE_UTILITY_DATA=/tmp/su-ultritouch STAGE_UTILITY_PORT=8799 npm run dev
```

Open `/screens`, New view → Custom Layout → console → Edit → Canvas → pick Ultritouch-2. Confirm the fit buttons grey out and Letterbox is lit. Pick 16:9; confirm they re-enable. Kill the server by port:

```bash
lsof -ti :8799 -sTCP:LISTEN | xargs kill
```

- [ ] **Step 7: Docs and commit**

In `docs/reference/layout-editor.md` under **Fit, and other window shapes**, after "A control surface with no fit stored is responsive; a wall screen is letterboxed." add:

```
An Ultritouch canvas is always letterboxed and the fit control is disabled while
one is chosen: the panel's pixels are known, so the layout keeps its shape and
scales evenly wherever it is previewed.
```

```bash
git add renderer/editor/layout-templates.ts renderer/editor/layout-editor.tsx renderer/editor/layout-editor-fit-lock.test.ts docs/reference/layout-editor.md
git commit -m "feat(layout-editor): an Ultritouch canvas locks Letterbox fit" -m "Guard proven red: canvasAfterPreset did not exist. Driven in the editor on a test server: fit buttons disable on an Ultritouch preset and re-enable on 16:9."
```

---

## PR B: the cue button

### Task 3: The manifest can include pairs hidden from Home Assistant

**Files:**
- Modify: `main/services/cue-manifest.ts:143-205`
- Modify: `main/services/routes/cue-routes.ts:176-183`
- Test: `main/services/cue-manifest.test.ts` (add a describe)

**Interfaces:**
- Produces: `cueManifest(opts?: { includeHidden?: boolean })`. With `includeHidden`, a hidden switch or button is listed with `hiddenFromHome: true`. `ManifestSwitch` and `ManifestButton` gain `hiddenFromHome?: true`. Route: `GET /api/cues/manifest?all=1`.

- [ ] **Step 1: Write the failing test**

Find how `cue-manifest.test.ts` builds rules and stubs `cueManifestDeps` (read its first 80 lines and copy the helper it uses to make a pair, one of which is hidden via `isHiddenFromHome` params). Add:

```ts
describe("a panel sees every cue, Home Assistant sees the shown ones", () => {
  test("includeHidden lists a hidden pair and says so", async () => {
    // Set up: one shown pair "projectors", one hidden pair "haze", one hidden button "confetti".
    // (use the file's existing rule builders; hidden = trigger.params.hiddenFromHome true)
    const forHome = await cueManifest();
    assert.deepEqual(forHome.switches.map((s) => s.id), ["projectors"]);
    assert.deepEqual(forHome.buttons.map((b) => b.id), []);

    const forPanel = await cueManifest({ includeHidden: true });
    assert.deepEqual(forPanel.switches.map((s) => [s.id, s.hiddenFromHome ?? false]), [["projectors", false], ["haze", true]]);
    assert.deepEqual(forPanel.buttons.map((b) => [b.id, b.hiddenFromHome ?? false]), [["confetti", true]]);
  });

  test("the default is unchanged, exactly", async () => {
    // The Home Assistant integration reads the default. A flag leaking into it
    // would create entities for pairs the operator hid.
    const forHome = await cueManifest();
    for (const s of forHome.switches) assert.equal("hiddenFromHome" in s, false);
  });
});
```

- [ ] **Step 2: Run it, expect red**

```bash
node --import tsx --test main/services/cue-manifest.test.ts
```
Expected: FAIL, `forPanel.switches` has one entry.

- [ ] **Step 3: Implement**

In `main/services/cue-manifest.ts`:

Add to both interfaces after `available: boolean;`:
```ts
  /** The operator hid this from Home Assistant. Present only when the caller
   *  asked for hidden cues; the default manifest omits the entry instead. */
  hiddenFromHome?: true;
```

Change the signature and the two skips:
```ts
export async function cueManifest(opts: { includeHidden?: boolean } = {}): Promise<CueManifest> {
```
In the switch loop replace
```ts
    if (pair.hiddenFromHome) {
      hidden += 1;
      continue;
    }
```
with
```ts
    if (pair.hiddenFromHome && !opts.includeHidden) {
      hidden += 1;
      continue;
    }
```
and after `if (pair.binding) entry.stateSource = pair.binding.variable;` add `if (pair.hiddenFromHome) entry.hiddenFromHome = true;`.

In the button loop replace
```ts
    if (isHiddenFromHome(rule.trigger.params)) {
      hidden += 1;
      continue;
    }
    buttons.push({
```
with
```ts
    const hiddenButton = isHiddenFromHome(rule.trigger.params);
    if (hiddenButton && !opts.includeHidden) {
      hidden += 1;
      continue;
    }
    buttons.push({
      ...(hiddenButton ? { hiddenFromHome: true as const } : {}),
```

In `main/services/routes/cue-routes.ts` replace the manifest handler body:
```ts
  if (method === "GET" && pathname === "/api/cues/manifest") {
    // Open, like the states route, the YAML and the token list. It carries cue
    // names, room names, on/off and this server's own LAN address — all of
    // which GET /api/automation/rules and GET /api/version already serve to
    // anyone on the LAN — and never a token.
    //
    // `?all=1` is the app's own console asking: a cue button on a panel must
    // list a pair the operator hid from Home Assistant, which the default
    // manifest leaves out for the integration that reads it.
    json(res, await cueManifest({ includeHidden: url.searchParams.get("all") === "1" }));
    return;
  }
```

- [ ] **Step 4: Run the tests, expect green**

```bash
node --import tsx --test main/services/cue-manifest.test.ts main/services/routes/cue-routes.test.ts
```

- [ ] **Step 5: Docs**

In `docs/reference/api.md` row for `GET /api/cues/manifest` (line 202), after "a hidden pair omits both halves rather than exposing them as buttons." insert: "`?all=1` lists hidden cues too, each carrying `hiddenFromHome: true`, for the app's own cue buttons; an integration must not pass it."

- [ ] **Step 6: Commit**

```bash
git add main/services/cue-manifest.ts main/services/routes/cue-routes.ts main/services/cue-manifest.test.ts docs/reference/api.md
git commit -m "feat(cues): the manifest can list pairs hidden from Home Assistant, for the app's own buttons" -m "Guard proven red: cueManifest ignored the option and listed one switch."
```

### Task 4: A `cues:all` channel beside `cues`

**Files:**
- Modify: `main/services/cue-live.ts:38-92,176-227`
- Modify: `renderer/lib/sse-channels.ts` (no change needed: pushes are deltas, the hook hydrates itself; confirm and leave)
- Test: `main/services/cue-live.test.ts` (add cases)

**Interfaces:**
- Produces: `export const CUES_ALL_CHANNEL = "cues:all"`; `cueLiveDeps.emitAll(event: CuesEvent)`. Every state row, hidden or not, is pushed on `cues:all` with `hiddenFromHome?: true`; `cues` behaviour is byte-identical to today. Manifest events go on both.

- [ ] **Step 1: Write the failing test**

Read `cue-live.test.ts` to see how it stubs `cueLiveDeps.read` and captures `emit`. Add, using the same fixtures:

```ts
describe("the all-cues channel", () => {
  test("a hidden pair is pushed on cues:all and not on cues", async () => {
    const forHome: CuesEvent[] = [];
    const forPanel: CuesEvent[] = [];
    cueLiveDeps.emit = (e) => forHome.push(e);
    cueLiveDeps.emitAll = (e) => forPanel.push(e);
    // read() answers two rows: "projectors" shown, "haze" hiddenFromHome.
    await tickOnce(); // whatever helper the file uses to run one tick
    assert.deepEqual(forHome.map((e) => e.type === "state" && e.id), ["projectors"]);
    assert.deepEqual(
      forPanel.map((e) => e.type === "state" && [e.id, e.hiddenFromHome ?? false]),
      [["projectors", false], ["haze", true]],
    );
  });

  test("a rules change announces the manifest on both", () => {
    const forHome: CuesEvent[] = []; const forPanel: CuesEvent[] = [];
    cueLiveDeps.emit = (e) => forHome.push(e);
    cueLiveDeps.emitAll = (e) => forPanel.push(e);
    cueLive.rulesChanged();
    assert.equal(forHome[0]?.type, "manifest");
    assert.equal(forPanel[0]?.type, "manifest");
  });
});
```

- [ ] **Step 2: Run it, expect red**

```bash
node --import tsx --test main/services/cue-live.test.ts
```
Expected: FAIL, `emitAll` is not a function.

- [ ] **Step 3: Implement**

In `main/services/cue-live.ts`:

```ts
export const CUES_CHANNEL = "cues";
/** Every pair, hidden from Home Assistant or not, for the app's own cue
 *  buttons. `cues` stays exactly what the integration has always read. */
export const CUES_ALL_CHANNEL = "cues:all";
```

Extend `CuesEvent`'s state variant: `({ type: "state"; id: string; hiddenFromHome?: true } & LiveRow)`.

Add to `cueLiveDeps` (type and value): `emitAll: (event: CuesEvent) => void;` / `emitAll: (event) => broadcast(CUES_ALL_CHANNEL, event),`.

`rulesChanged()`:
```ts
  rulesChanged(): void {
    const event: CuesEvent = { type: "manifest", version: bumpManifestVersion() };
    cueLiveDeps.emit(event);
    cueLiveDeps.emitAll(event);
    this.last.clear();
  }
```

`tick()`: keep `last` keyed for the HOME channel as today, and add a second map `lastAll` for the all channel. Replace the body of the `try`:
```ts
      const answer = await cueLiveDeps.read();
      const all = [...answer.states];
      const shown = all.filter(([, row]) => !row.hiddenFromHome);
      this.push(shown, this.last, cueLiveDeps.emit, false);
      this.push(all, this.lastAll, cueLiveDeps.emitAll, true);
```
and add the method:
```ts
  /** Push what changed since the last round on one channel. */
  private push(
    rows: [string, LiveRow & { hiddenFromHome?: true }][],
    last: Map<string, string>,
    emit: (event: CuesEvent) => void,
    sayHidden: boolean,
  ): void {
    for (const [id, row] of rows) {
      const key = `${row.state} ${row.reason ?? ""} ${row.commanded ?? ""}`;
      if (last.get(id) === key) continue;
      last.set(id, key);
      const event: CuesEvent = { type: "state", id, state: row.state };
      if (row.reason) event.reason = row.reason;
      if (row.settling) {
        event.settling = true;
        event.commanded = row.commanded;
      }
      if (sayHidden && row.hiddenFromHome) event.hiddenFromHome = true;
      emit(event);
    }
    const pushed = new Set(rows.map(([id]) => id));
    for (const id of last.keys()) if (!pushed.has(id)) last.delete(id);
  }
```
Declare `private lastAll = new Map<string, string>();` and clear it wherever `this.last.clear()` is called. Check `subscribers()`/`watched()` in `cueLiveDeps`: they count subscribers of `CUES_CHANNEL`; make them count `cues:all` too (read how `watched` is implemented and add the second channel), otherwise a panel alone never starts the poll.

- [ ] **Step 4: Run, expect green**

```bash
node --import tsx --test main/services/cue-live.test.ts
```

- [ ] **Step 5: Docs**

In `docs/reference/api.md` channel list (line 386) add `cues:all` after `cues`, and after the `cues` paragraph add:

```
`cues:all` is the same two messages for the app's own cue buttons, carrying
every pair including those hidden from Home Assistant (each with
`hiddenFromHome: true`). An integration reads `cues`; a panel reads `cues:all`.
Either channel having a subscriber starts the five-second read.
```

- [ ] **Step 6: Commit**

```bash
git add main/services/cue-live.ts main/services/cue-live.test.ts docs/reference/api.md
git commit -m "feat(cues): a cues:all channel carries hidden pairs for the app's own buttons" -m "cues is byte-identical for Home Assistant. Guards proven red: emitAll did not exist."
```

### Task 5: A same-origin browser may call a cue

**Files:**
- Modify: `main/services/routes/cue-routes.ts:1-30,186-190`
- Modify: `main/services/routes/cue-routes.test.ts:277-286`
- Modify: `SECURITY.md:68-101`, `docs/reference/api.md:198`

**Interfaces:**
- Produces: `POST /api/cues/<name>` from a same-origin browser runs the cue with caller label `console`. Anything with no matching `Origin` still needs a token.

- [ ] **Step 1: Flip the guard, expect red**

Replace the test at line 277:

```ts
  test("a same-origin browser calls a cue as the console, no token", async () => {
    // The premise this route was built on — no operator-at-the-console case —
    // stopped being true when a cue button became a layout object. A browser on
    // this origin can already press the same gear through /api/action/invoke
    // and edit the rule itself, so this grants nothing new. See the header.
    await withCue();
    const r = await callRoute(cueRoutes, "/api/cues/projectors_on", {
      method: "POST",
      headers: browser,
    });
    assert.equal(r.status, 200);
  });

  test("no Origin still needs a token", async () => {
    await withCue();
    const r = await callRoute(cueRoutes, "/api/cues/projectors_on", { method: "POST", headers: {} });
    assert.equal(r.status, 401);
  });
```

```bash
node --import tsx --test main/services/routes/cue-routes.test.ts
```
Expected: FAIL, first test gets 401.

- [ ] **Step 2: Implement**

At line 188 change `requireCaller(c, { allowSameOrigin: false })` to `requireCaller(c, { allowSameOrigin: true })`. Read `requireCaller` to confirm the same-origin caller carries `id: "browser"`; the existing `if (caller.id !== "browser" && result.status === 200)` then already skips `touch()`. If the browser caller's `label` is not `console`, set the label passed to `callByName` to `caller.id === "browser" ? "console" : caller.label`.

Rewrite the first gate bullet in the header comment:

```
//  - `POST /api/cues/<name>` needs a bearer token unless the request is a
//    same-origin browser write — a cue button on a console is an operator at
//    the console. Until the cue button existed there was no such case and the
//    route refused browsers too; the exemption is the same one the management
//    writes and /api/action/invoke use, and a browser on this origin could
//    already press the same gear through the latter.
```

- [ ] **Step 3: Run, expect green**

```bash
node --import tsx --test main/services/routes/cue-routes.test.ts
```

- [ ] **Step 4: Docs**

`docs/reference/api.md` line 198: change "`401` no token" to "`401` no token (a same-origin browser, such as a cue button on a console, needs none)".

`SECURITY.md`: read lines 68–101 and amend the sentence that says the call route always needs a token to say it needs one from anything that is not a same-origin browser, matching `/api/action/invoke`, and why that grants nothing new.

- [ ] **Step 5: Commit**

```bash
git add main/services/routes/cue-routes.ts main/services/routes/cue-routes.test.ts SECURITY.md docs/reference/api.md
git commit -m "feat(cues): a same-origin browser may call a cue" -m "For the cue button on a console. Grants nothing a browser on this origin could not already do through /api/action/invoke. Guard flipped and proven red first: the browser got 401."
```

### Task 6: The `cue-button` type, capability and catalog entry

**Files:**
- Modify: `main/types/views.ts:490`
- Modify: `main/types/object-capabilities.ts:42`
- Modify: `main/types/object-capabilities.test.ts:15-40`
- Modify: `renderer/main/layout-objects.ts:758-764`
- Modify: `renderer/main/object-catalog.test.ts:16-19`
- Modify: `renderer/editor/palette.tsx:76`
- Modify: `docs/reference/widgets.md:430-445`

**Interfaces:**
- Produces: `{ type: "cue-button"; cue: string; label?: string; showDevice?: boolean }` in `LayoutObjectConfig`. `cue` is a manifest id: a switch's pair base, or a button's cue name. Empty means unbound.

- [ ] **Step 1: Move the exact counts, expect red**

`main/types/object-capabilities.test.ts`: change `61` to `62` in both the count and the message; add `"cue-button"` to the sorted controls list: `["action-button", "cue-button", "live-controls", "osc-button", "rosstalk-button"]`.
`renderer/main/object-catalog.test.ts`: change `61` to `62`.

```bash
node --import tsx --test main/types/object-capabilities.test.ts renderer/main/object-catalog.test.ts renderer/main/widget-docs.test.ts
```
Expected: FAIL on both counts.

- [ ] **Step 2: Implement**

`main/types/views.ts` after line 490:
```ts
  // A cue from the cue manifest, with its live state on the button. `cue` is the
  // manifest id: a pair's base for a switch, the cue name for a lone button.
  // Empty is unbound and renders as such, never as a fake state.
  | { type: "cue-button"; cue: string; label?: string; showDevice?: boolean }
```

`main/types/object-capabilities.ts` after the action-button line:
```ts
  // A cue with its state on it. A control on a panel; a readout on a wall.
  "cue-button": ["control"],
```
(Read `capabilityLive` in `renderer/main/render-context.ts`: a `control` on a `display` context is already rendered inert. No `readout` entry is needed for it to draw.)

`renderer/main/layout-objects.ts` after the action-button spec:
```ts
  "cue-button": {
    label: "Cue button",
    blurb: "Fires a cue and shows whether its device is on",
    group: "Control",
    config: () => ({ type: "cue-button", cue: "", label: "", showDevice: true }),
    style: () => PILL({ fontSize: 0.12 }),
  },
```

`renderer/editor/palette.tsx`: add `"cue-button": ToggleRightIcon,` and import `ToggleRightIcon` from `lucide-react`.

`docs/reference/widgets.md` Control table, after the Action button row:
```
| **Cue button** | Fires a cue and shows its device's state: on, off, settling after a press, stale when Companion has lost the device, dimmed when the cue refuses | This app, via Companion |
```

- [ ] **Step 3: Run, expect green (typecheck forces the renderer switch in Task 8; expect one error there until then)**

```bash
node --import tsx --test main/types/object-capabilities.test.ts renderer/main/object-catalog.test.ts renderer/main/widget-docs.test.ts
```
`npm run -s type-check` will fail with a non-exhaustive `switch` in `layout-renderer.tsx` until Task 8. Do not commit a broken typecheck: add a temporary `case "cue-button": return <span>cue</span>;` at line 1338 now and replace it in Task 8.

- [ ] **Step 4: Commit**

```bash
git add main/types/views.ts main/types/object-capabilities.ts main/types/object-capabilities.test.ts renderer/main/layout-objects.ts renderer/main/object-catalog.test.ts renderer/editor/palette.tsx renderer/main/layout-renderer.tsx docs/reference/widgets.md
git commit -m "feat(layout): a cue-button object type, registered as a control" -m "Both exact-count guards moved 61 to 62 and were red first."
```

### Task 7: The `useCueLive` hook and the invoke cases

**Files:**
- Modify: `renderer/lib/api.ts:853`
- Create: `renderer/main/use-cue-live.ts`
- Test: `renderer/main/use-cue-live.test.ts`

**Interfaces:**
- Produces:
```ts
export interface CuesLive { manifest: CueManifest; states: Map<string, LiveState> }
export interface LiveState { state: CueStateName; reason?: string; settling?: true; commanded?: "on" | "off" }
export function useCueLive(enabled: boolean): CuesLive | null
export function applyCueEvent(live: CuesLive, e: CuesEvent): CuesLive   // pure, tested
export function cueEntry(live: CuesLive | null, id: string): { kind: "switch"; row: ManifestSwitch } | { kind: "button"; row: ManifestButton } | null
```
- `invoke("cues:manifest")` → `GET /api/cues/manifest?all=1`; `invoke("cues:call", { name })` → `POST /api/cues/<name>`, resolving to the body whatever the status (200, 202, 409) as `{ ok?: boolean; detail?: string; error?: string; reason?: string; skipped?: boolean; state?: string; status: number }`.

- [ ] **Step 1: Write the failing test for the pure parts**

```ts
// renderer/main/use-cue-live.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { applyCueEvent, cueEntry, type CuesLive } from "./use-cue-live.js";

const base: CuesLive = {
  manifest: {
    version: 3,
    server: { name: "t", lanUrl: null },
    switches: [{ id: "haze", name: "Haze", room: "", on: "haze_on", off: "haze_off", toggle: false, state: "off", available: true }],
    buttons: [{ id: "confetti", name: "Confetti", room: "", cue: "confetti", available: true }],
  },
  states: new Map(),
};

describe("cue live state", () => {
  test("a state event lands on its pair and nothing else", () => {
    const next = applyCueEvent(base, { type: "state", id: "haze", state: "on" });
    assert.deepEqual(next.states.get("haze"), { state: "on" });
    assert.equal(base.states.size, 0, "input not mutated");
  });

  test("a settling event carries what was asked for", () => {
    const next = applyCueEvent(base, { type: "state", id: "haze", state: "off", settling: true, commanded: "on" });
    assert.deepEqual(next.states.get("haze"), { state: "off", settling: true, commanded: "on" });
  });

  test("a manifest event with a new version marks the manifest stale", () => {
    const next = applyCueEvent(base, { type: "manifest", version: 4 });
    assert.equal(next.manifest.version, 3, "the manifest itself is re-read by the hook, not invented here");
    assert.equal(next.staleManifest, true);
  });

  test("cueEntry finds a switch by base and a button by name", () => {
    assert.equal(cueEntry(base, "haze")?.kind, "switch");
    assert.equal(cueEntry(base, "confetti")?.kind, "button");
    assert.equal(cueEntry(base, "nothing"), null);
    assert.equal(cueEntry(null, "haze"), null);
  });
});
```

- [ ] **Step 2: Run it, expect red**

```bash
node --import tsx --test renderer/main/use-cue-live.test.ts
```

- [ ] **Step 3: Implement**

`renderer/lib/api.ts` after the `cues:states` case:
```ts
    // The app's own cue buttons: every cue, hidden from Home Assistant or not.
    case "cues:manifest": return apiFetch("/api/cues/manifest?all=1");
    // Whatever the status, the body is the answer: 200 dispatched, 202 needs a
    // confirmation the panel cannot give, 409 refused with a reason. The button
    // reads all three; throwing on a 409 would turn "not allowed during a
    // service" into a generic failure toast.
    case "cues:call": {
      const res = await fetch(`/api/cues/${encodeURIComponent(String(p.name))}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ...body, status: res.status } as T;
    }
```
(Check how other cases build a POST with `post()`; if `post()` throws on non-2xx, keep the explicit fetch above.)

`renderer/main/use-cue-live.ts`:
```ts
// Live cue state for the cue-button object: the manifest (which cues exist,
// what they are called, whether each can be pressed) plus the per-pair state
// pushed on the "cues:all" channel. Hydrates from the manifest read, which
// carries each switch's current state, then applies pushes as they come.
//
// Not useStatusChannel: that hook expects every push to be a whole new value,
// and this channel pushes one pair at a time.

import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";
import type { CueManifest, ManifestButton, ManifestSwitch } from "@main/services/cue-manifest";
import type { CuesEvent } from "@main/services/cue-live";
import type { CueStateName } from "@main/services/cue-states";

export interface LiveState {
  state: CueStateName;
  reason?: string;
  settling?: true;
  commanded?: "on" | "off";
}

export interface CuesLive {
  manifest: CueManifest;
  states: Map<string, LiveState>;
  /** A manifest event arrived with a newer version; the hook re-reads. */
  staleManifest?: true;
}

/** One event folded into the live picture. Pure; the hook and the tests share it. */
export function applyCueEvent(live: CuesLive, e: CuesEvent): CuesLive {
  if (e.type === "manifest") {
    return e.version === live.manifest.version ? live : { ...live, staleManifest: true };
  }
  const next: LiveState = { state: e.state };
  if (e.reason) next.reason = e.reason;
  if (e.settling) {
    next.settling = true;
    next.commanded = e.commanded;
  }
  const states = new Map(live.states);
  states.set(e.id, next);
  return { ...live, states };
}

/** The manifest entry a button is bound to, or null when unbound or gone. */
export function cueEntry(
  live: CuesLive | null,
  id: string,
): { kind: "switch"; row: ManifestSwitch } | { kind: "button"; row: ManifestButton } | null {
  if (!live || !id) return null;
  const sw = live.manifest.switches.find((s) => s.id === id);
  if (sw) return { kind: "switch", row: sw };
  const b = live.manifest.buttons.find((x) => x.id === id);
  return b ? { kind: "button", row: b } : null;
}

function fromManifest(manifest: CueManifest): CuesLive {
  const states = new Map<string, LiveState>();
  for (const s of manifest.switches) {
    const row: LiveState = { state: s.state };
    if (s.reason) row.reason = s.reason;
    if (s.settling) {
      row.settling = true;
      row.commanded = s.commanded;
    }
    states.set(s.id, row);
  }
  return { manifest, states };
}

export function useCueLive(enabled: boolean): CuesLive | null {
  const [live, setLive] = useState<CuesLive | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const read = () =>
      invoke<CueManifest>("cues:manifest")
        .then((m) => { if (alive && m) setLive((prev) => {
          // Pushes that landed during the read win over the read's snapshot.
          const fresh = fromManifest(m);
          if (!prev) return fresh;
          for (const [id, s] of prev.states) if (!fresh.states.has(id)) fresh.states.set(id, s);
          return fresh;
        }); })
        .catch(() => { /* the next manifest event or remount re-reads; the button shows unbound meanwhile */ });
    void read();
    const off = onNotification<CuesEvent>("cues:all", (e) => {
      setLive((prev) => (prev ? applyCueEvent(prev, e) : prev));
      if (e.type === "manifest") void read();
    });
    return () => { alive = false; off(); };
  }, [enabled]);

  return live;
}
```
(Check `onNotification`'s exact signature in `renderer/lib/api.ts:1337` and adapt the generic. The `catch` that only comments is acceptable here only because the button renders "Unbound" on a null manifest, which is a visible failure, not a swallowed one; say so in the commit.)

- [ ] **Step 4: Run, typecheck**

```bash
node --import tsx --test renderer/main/use-cue-live.test.ts && npm run -s type-check
```

- [ ] **Step 5: Commit**

```bash
git add renderer/lib/api.ts renderer/main/use-cue-live.ts renderer/main/use-cue-live.test.ts
git commit -m "feat(cues): a live cue hook over the cues:all channel" -m "Pure fold and lookup proven red first."
```

### Task 8: The `CueButton` component, rendered by the layout

**Files:**
- Create: `renderer/main/cue-button.tsx`
- Modify: `renderer/main/layout-renderer.tsx:76` (ctx field), `:1338` (case), `:2966` (hook), `:2995` and `:3029` (plumbing)
- Modify: `renderer/main/test-render-ctx.ts:67-100` (`cues: null`)
- Test: `renderer/main/cue-button.test.tsx`

**Interfaces:**
- Consumes: `useCueLive`, `cueEntry`, `CuesLive` from Task 7; `interactive` from ctx.
- Produces: `LayoutRenderCtx.cues: CuesLive | null`; `export const cueButtonDeps = { call: (name: string) => invoke<CallAnswer>("cues:call", { name }) }`.

- [ ] **Step 1: Write the failing test**

```tsx
// renderer/main/cue-button.test.tsx
// The cue button has to SAY the state, and press the right half. Rendered,
// because the defect this guards is a lamp that lights for the wrong reason.
import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();
class NoStream { close() {} addEventListener() {} removeEventListener() {} }
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");
const { cueButtonDeps } = await import("./cue-button.js");
const { type CuesLive } = await import("./use-cue-live.js");

after(() => { cleanup(); teardown(); });

function live(over: Partial<CuesLive["manifest"]["switches"][number]> = {}, state?: { state: "on" | "off" | "unknown"; reason?: string; settling?: true; commanded?: "on" | "off" }): CuesLive {
  const sw = { id: "haze", name: "Haze", room: "Stage", on: "haze_on", off: "haze_off", toggle: false, state: "off" as const, available: true, stateSource: "companion:haze", ...over };
  return {
    manifest: { version: 1, server: { name: "t", lanUrl: null }, switches: [sw], buttons: [{ id: "confetti", name: "Confetti", room: "", cue: "confetti", available: true }] },
    states: new Map(state ? [["haze", state]] : [["haze", { state: sw.state }]]),
  };
}

function mount(cues: CuesLive | null, cue: string, interactive = true) {
  cleanup();
  const ctx = makeRenderCtx({ cues, interactive });
  const obj = { id: "o1", x: 0, y: 0, w: 0.1, h: 0.5, z: 1, config: { type: "cue-button", cue, showDevice: true }, style: {} } as never;
  return render(React.createElement(ObjectContent as never, { o: obj, ctx }));
}

describe("cue button", () => {
  test("unbound says so and fires nothing", async () => {
    let calls = 0; cueButtonDeps.call = async () => { calls++; return { status: 200, ok: true, detail: "" }; };
    const { container } = mount(live(), "");
    assert.match(container.textContent ?? "", /Unbound/);
    fireEvent.click(container.querySelector("button")!);
    assert.equal(calls, 0);
  });

  test("each state is named on the button", () => {
    assert.equal(mount(live({}, { state: "off" }), "haze").container.querySelector("[data-state]")?.getAttribute("data-state"), "off");
    assert.equal(mount(live({}, { state: "on" }), "haze").container.querySelector("[data-state]")?.getAttribute("data-state"), "on");
    assert.equal(mount(live({}, { state: "off", settling: true, commanded: "on" }), "haze").container.querySelector("[data-state]")?.getAttribute("data-state"), "settling");
    const stale = mount(live({}, { state: "unknown", reason: "Companion: Connection Failure" }), "haze");
    assert.equal(stale.container.querySelector("[data-state]")?.getAttribute("data-state"), "stale");
    assert.match(stale.container.textContent ?? "", /Connection Failure/);
    assert.equal(mount(live({ available: false }), "haze").container.querySelector("[data-state]")?.getAttribute("data-state"), "unavailable");
  });

  test("a switch that is off presses ON, one that is on presses OFF", async () => {
    const names: string[] = [];
    cueButtonDeps.call = async (n) => { names.push(n); return { status: 200, ok: true, detail: "dispatched" }; };
    fireEvent.click(mount(live({}, { state: "off" }), "haze").container.querySelector("button")!);
    fireEvent.click(mount(live({}, { state: "on" }), "haze").container.querySelector("button")!);
    fireEvent.click(mount(live(), "confetti").container.querySelector("button")!);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(names, ["haze_on", "haze_off", "confetti"]);
  });

  test("unavailable does not fire; a wall display does not fire", async () => {
    let calls = 0; cueButtonDeps.call = async () => { calls++; return { status: 200, ok: true, detail: "" }; };
    fireEvent.click(mount(live({ available: false }), "haze").container.querySelector("button")!);
    fireEvent.click(mount(live(), "haze", false).container.querySelector("button")!);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls, 0);
  });

  test("a refusal is shown, not swallowed", async () => {
    cueButtonDeps.call = async () => ({ status: 409, error: "Not allowed during a service", reason: "service-live" });
    const { container } = mount(live(), "haze");
    fireEvent.click(container.querySelector("button")!);
    await new Promise((r) => setTimeout(r, 0));
    assert.match(container.textContent ?? "", /Not allowed during a service/);
  });
});
```

- [ ] **Step 2: Run it, expect red**

```bash
node --import tsx --test renderer/main/cue-button.test.tsx
```
Expected: FAIL, `./cue-button.js` not found.

- [ ] **Step 3: Implement the component**

```tsx
// renderer/main/cue-button.tsx
// A cue from the manifest, with its state on it. The general form of a
// Companion "toggle" button for a panel: the label, the device it drives, and a
// mark that says what the device is DOING, from the same reading Home Assistant
// gets. A switch shows the state it is in, never the state it was asked for —
// except in the settle window after a press, where it shows what was asked and
// says it is settling.
//
// `interactive` is decided by the rendering context, not here: a wall display
// renders this as a readout and never binds the press. See render-context.ts.

import { useState, type CSSProperties } from "react";
import { Loader2Icon } from "lucide-react";

import { invoke } from "../lib/api";
import { cueEntry, type CuesLive } from "./use-cue-live";

export interface CallAnswer {
  status: number;
  ok?: boolean;
  detail?: string;
  error?: string;
  reason?: string;
  skipped?: boolean;
}

/** The seam a test replaces; production posts the cue. */
export const cueButtonDeps = {
  call: (name: string): Promise<CallAnswer> => invoke<CallAnswer>("cues:call", { name }),
};

export type CueButtonState = "unbound" | "idle" | "on" | "settling" | "stale" | "unavailable";

/** What the button shows, from the manifest entry and the live row. Exported for the test and the inspector preview. */
export function cueButtonState(cues: CuesLive | null, id: string): { state: CueButtonState; sub: string; name: string } {
  const entry = cueEntry(cues, id);
  if (!entry) return { state: "unbound", sub: "", name: "" };
  const { row } = entry;
  const name = row.name;
  if (!row.available) return { state: "unavailable", sub: "Button missing in Companion", name };
  if (entry.kind === "button") return { state: "idle", sub: row.room, name };
  const live = cues!.states.get(row.id) ?? { state: row.state, reason: row.reason, settling: row.settling, commanded: row.commanded };
  if (live.settling) return { state: "settling", sub: `Turning ${live.commanded ?? "on"}…`, name };
  if (live.state === "unknown" && row.stateSource) return { state: "stale", sub: live.reason ?? "Reading unavailable", name };
  if (live.state === "on") return { state: "on", sub: row.room, name };
  return { state: "idle", sub: row.room, name };
}

export function CueButton({
  config,
  cues,
  interactive,
  ts,
}: {
  config: { type: "cue-button"; cue: string; label?: string; showDevice?: boolean };
  cues: CuesLive | null;
  interactive: boolean;
  ts: CSSProperties;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const { state, sub, name } = cueButtonState(cues, config.cue);
  const entry = cueEntry(cues, config.cue);
  const canFire = interactive && !busy && entry !== null && state !== "unavailable";

  async function fire() {
    if (!canFire || !entry) return;
    const target =
      entry.kind === "button"
        ? entry.row.cue
        : state === "on" ? entry.row.off : entry.row.on; // unknown or stale presses ON
    setBusy(true);
    setSaid(null);
    try {
      const r = await cueButtonDeps.call(target);
      if (r.status === 200) { if (r.skipped) setSaid(r.detail ?? "Already there"); }
      else if (r.status === 202) setSaid("Needs confirmation; use the rules page");
      else setSaid(r.error ?? r.detail ?? "Refused");
    } catch {
      setSaid("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const label = config.label || name || "Unbound";
  const line2 = said ?? (config.showDevice === false ? "" : sub);

  return (
    <button
      type="button"
      data-state={state}
      onClick={fire}
      disabled={!canFire}
      aria-label={label}
      style={{
        ...ts,
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.15em",
        border: "none",
        borderRadius: "inherit",
        cursor: canFire ? "pointer" : "default",
        pointerEvents: interactive ? "auto" : "none",
        opacity: state === "unavailable" ? 0.4 : 1,
        boxShadow:
          state === "on" ? "inset 0 0 0 0.12em var(--green-9)"
          : state === "stale" ? "inset 0 0 0 0.08em var(--amber-9)"
          : undefined,
        outline: state === "stale" ? "0.08em dashed var(--amber-9)" : undefined,
        outlineOffset: state === "stale" ? "-0.16em" : undefined,
        background: state === "settling" ? "color-mix(in srgb, var(--brand-accent) 30%, transparent)" : ts.background,
      }}
    >
      <span
        aria-hidden
        style={{
          width: "0.55em", height: "0.55em", borderRadius: "50%",
          background: state === "on" ? "var(--green-9)" : state === "settling" ? "var(--amber-9)" : "var(--su-fg-faint)",
        }}
      />
      <span style={{ fontWeight: 600, letterSpacing: "0.02em", textTransform: "uppercase", lineHeight: 1.05 }}>
        {busy ? <Loader2Icon className="size-[1em] animate-spin" /> : label}
      </span>
      {line2 && (
        <span style={{ fontSize: "0.55em", opacity: 0.75, color: state === "stale" ? "var(--amber-9)" : undefined, lineHeight: 1.1 }}>
          {line2}
        </span>
      )}
    </button>
  );
}
```
Check the token names `--green-9`, `--amber-9`, `--su-fg-faint`, `--brand-accent` exist in `renderer/styles.css` (grep) and substitute the repo's real ones if they differ. Dark surfaces stay R=G=B; only the state colours are hued.

- [ ] **Step 4: Wire the renderer**

`renderer/main/layout-renderer.tsx`:
- Import `{ CueButton }` from `./cue-button` and `{ useCueLive, type CuesLive }` from `./use-cue-live`.
- ctx type (near line 76): add `/** Live cue manifest and states — for the cue-button object. null until loaded. */ cues: CuesLive | null;`
- Replace the temporary case at line 1338:
```tsx
    case "cue-button":
      return <CueButton config={c} cues={ctx.cues} interactive={ctx.interactive} ts={ts} />;
```
- Near line 2966: `const cues = useCueLive(want(["cue-button"]));`
- Add `cues` to the return object at line 2995 and the destructure at line 3029, and to wherever the ctx object is built from those (grep `osc,` in the ctx literal after line 3029 and add `cues,` beside it).

`renderer/main/test-render-ctx.ts`: add `cues: null,` after `osc: null,`.

- [ ] **Step 5: Run, typecheck, lint**

```bash
node --import tsx --test renderer/main/cue-button.test.tsx renderer/main/object-catalog.test.ts main/types/object-capabilities.test.ts && npm run -s type-check && npm run -s lint
```

- [ ] **Step 6: Commit**

```bash
git add renderer/main/cue-button.tsx renderer/main/cue-button.test.tsx renderer/main/layout-renderer.tsx renderer/main/test-render-ctx.ts
git commit -m "feat(layout): the cue button renders a cue's live state and fires it" -m "Rendered guards proven red first: the module did not exist. Unknown or stale presses ON, and says so in the docs."
```

### Task 9: The inspector, and the real path

**Files:**
- Modify: `renderer/editor/inspector.tsx` (after the `action-button` block; find `c.type === "action-button"`, or after the osc block at 1271 if none exists)
- Modify: `docs/reference/widgets.md` (Control section prose), `docs/features/operator-app.md` (Consoles)

- [ ] **Step 1: Implement the inspector block**

Import `useCueLive` in `inspector.tsx`; call `const cues = useCueLive(c.type === "cue-button");` beside the other hooks at the top of the component (hooks cannot be conditional; the flag is the argument). Add:

```tsx
      {c.type === "cue-button" && (() => {
        const switches = cues?.manifest.switches ?? [];
        const buttons = cues?.manifest.buttons ?? [];
        return (
          <>
            <Row label="Cue" hint="A pair from the rules list shows on and off; a lone cue is a momentary button. Pairs hidden from Home Assistant are listed too.">
              <Select value={c.cue} onValueChange={(v: string) => onConfig({ ...c, cue: v })}>
                <SelectTrigger><SelectValue placeholder={cues ? "Select a cue" : "Loading cues…"} /></SelectTrigger>
                <SelectContent>
                  {switches.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}{s.room ? ` · ${s.room}` : ""} (switch)</SelectItem>)}
                  {buttons.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}{b.room ? ` · ${b.room}` : ""} (button)</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <RowText label="Label" hint="Blank uses the cue's own name." value={c.label ?? ""} placeholder="Cue's name" onChange={(v) => onConfig({ ...c, label: v })} />
            <RowSwitch label="Show device" hint="The room or device under the label, and the reason when a reading is stale." checked={c.showDevice !== false} onChange={(v) => onConfig({ ...c, showDevice: v })} />
          </>
        );
      })()}
```

- [ ] **Step 2: Typecheck and lint**

```bash
npm run -s type-check && npm run -s lint
```

- [ ] **Step 3: Drive the real path on a test server**

Companion must NOT be reachable from the test server. Use an EMPTY data dir and seed the cues you need through the API; a copied data dir dials real devices regardless of integration flags. Confirm after boot:

```bash
mkdir -p /tmp/su-cue && STAGE_UTILITY_DATA=/tmp/su-cue STAGE_UTILITY_PORT=8799 npm run dev
```
```bash
curl -s localhost:8799/api/version && grep -c "\[companion\]" <server log> 
```
The grep must be 0 before you continue. Then:
1. Automation → confirm at least one cue pair exists (create one whose action is `log.message` if not; never `companion.press`).
2. New console view → Ultritouch-2 preset → add a Cue button → bind it in the inspector → Done.
3. Open `/consoles/<id>`; tap it. Expect the automation log to show the call with caller `console`, and the button to show the refusal or "dispatched".
4. Open the same view on a `display`-mode screen's URL; confirm the button draws its state and does nothing on tap.
5. Kill by port: `lsof -ti :8799 -sTCP:LISTEN | xargs kill`.

- [ ] **Step 4: Docs**

`docs/reference/widgets.md` after the Control table's closing prose, add:

```
**Cue button** binds to a cue from the rules list, including pairs hidden from
Home Assistant. A pair shows on or off from its state variable; a tap presses
the opposite half, and a pair whose reading is unknown presses ON. In the eight
seconds after a press it shows what was asked for and says it is settling. A
dashed amber ring means Companion has lost the device and the reading cannot be
trusted. A cue that refuses — switched off, disarmed, not allowed during a
service — says why on the button. One that needs a confirmation cannot be fired
from a panel; the rules page has the Test button for that.
```

`docs/features/operator-app.md` Consoles section, after the "Building one" paragraph, add: "A console meant for a Ross Ultritouch panel has its own presets and a starter; see [Ultritouch](../integrations/ultritouch.md)."

- [ ] **Step 5: Commit**

```bash
git add renderer/editor/inspector.tsx docs/reference/widgets.md docs/features/operator-app.md
git commit -m "feat(layout-editor): bind a cue button in the inspector" -m "Driven on a test server with Companion disabled and zero [companion] log lines: a tap lands in the automation log as console, a wall display draws the state and fires nothing."
```

---

## PR C: strips and the Ultritouch page

### Task 10: Strip starter templates

**Files:**
- Modify: `renderer/editor/layout-templates.ts`
- Modify: `renderer/settings/sections/new-view-dialog.tsx:53-61,95-105`
- Modify: `renderer/editor/layout-editor.tsx:109,1538-1552` and the starters menu that calls `startFromDashboard`
- Test: `renderer/editor/layout-templates.test.ts` (extend)

**Interfaces:**
- Produces: `export type UltritouchModel = "ultritouch-2" | "ultritouch-2-hr" | "ultritouch-4"`; `export function ultritouchTemplate(model: UltritouchModel): LayoutObject[]`; `export function ultritouchCanvas(model: UltritouchModel): LayoutCanvas` returning `{ width, height, background: "#0e0e0e", fit: "contain" }`.

- [ ] **Step 1: Write the failing test**

```ts
describe("Ultritouch strip templates", () => {
  for (const model of ["ultritouch-2", "ultritouch-2-hr", "ultritouch-4"] as const) {
    test(`${model}: eight cue buttons per row and one countdown, all on the canvas`, () => {
      const objects = ultritouchTemplate(model);
      const cueButtons = objects.filter((o) => o.config.type === "cue-button");
      assert.equal(cueButtons.length, model === "ultritouch-4" ? 16 : 8);
      assert.equal(objects.filter((o) => o.config.type === "countdown-timer").length, 1);
      assert.equal(objects.length, cueButtons.length + 1);
      for (const o of objects) {
        assert.ok(o.x >= 0 && o.y >= 0 && o.x + o.w <= 1.0001 && o.y + o.h <= 1.0001, `${o.id} off the canvas`);
      }
      // Unbound: a template must never ship a cue name that may not exist here.
      for (const b of cueButtons) assert.equal((b.config as { cue: string }).cue, "");
      const canvas = ultritouchCanvas(model);
      assert.equal(canvas.fit, "contain");
      assert.equal(canvas.background, "#0e0e0e");
    });
  }
});
```

- [ ] **Step 2: Run it, expect red**

```bash
node --import tsx --test renderer/editor/layout-templates.test.ts
```

- [ ] **Step 3: Implement**

Append to `renderer/editor/layout-templates.ts`:

```ts
export type UltritouchModel = "ultritouch-2" | "ultritouch-2-hr" | "ultritouch-4";

export function ultritouchCanvas(model: UltritouchModel): LayoutCanvas {
  const p = ULTRITOUCH_PRESETS.find((x) => x.id === model)!;
  // The kiosk ground, so the letterbox bars and the buttons' ground are one colour.
  return { width: p.w, height: p.h, background: "#0e0e0e", fit: "contain" };
}

/**
 * A row of eight cue buttons (two rows on the 4) and a countdown at the right,
 * proportioned to the panel. Fractions of the canvas, like every layout; the
 * pixel figures in the comments are what they come to on the real panel.
 */
export function ultritouchTemplate(model: UltritouchModel): LayoutObject[] {
  const rows = model === "ultritouch-4" ? 2 : 1;
  const pad = 0.06;                 // of height: 12 px on a 203 strip
  const gapX = 0.008;               // of width
  const readoutW = 0.16;            // of width
  const gridW = 1 - pad * (203 / 1366) * 2 - readoutW - gapX; // buttons' share of the width
  const left = pad * (203 / 1366);
  const cols = 8;
  const bw = (gridW - gapX * (cols - 1)) / cols;
  const bh = (1 - pad * 2 - (rows - 1) * pad) / rows;
  const objects: LayoutObject[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      objects.push({
        id: uid(),
        x: left + c * (bw + gapX),
        y: pad + r * (bh + pad),
        w: bw,
        h: bh,
        z: 1,
        config: { type: "cue-button", cue: "", label: "", showDevice: true },
        // Label ≈ 26 px on the 2, 36 on the 2-HR, 30 on the 4: a fraction of HEIGHT.
        style: PILL({ fontSize: model === "ultritouch-4" ? 0.062 : 0.128 }),
      });
    }
  }
  objects.push({
    id: uid(),
    x: 1 - left - readoutW,
    y: pad,
    w: readoutW,
    h: 1 - pad * 2,
    z: 1,
    config: { type: "countdown-timer", caption: "TO END OF SET", hideWhenIdle: false },
    style: { fontSize: model === "ultritouch-4" ? 0.25 : 0.32, fontWeight: 500, color: "#ededf0", textAlign: "left", vAlign: "middle" },
  });
  return objects;
}
```
Check `PILL` and `uid` are in scope in this file (they are used above in it), and that `LayoutObject` is imported. Adjust the `fontSize` fractions if `countdown-timer`'s renderer scales differently; the pixel targets in the spec are the truth.

- [ ] **Step 4: Offer the starters**

`new-view-dialog.tsx`: extend `type StartFrom = "blank" | "dashboard" | "confidence" | UltritouchModel;`, add three `<SelectItem>`s after the Confidence Monitor one (`Ultritouch-2 strip`, `Ultritouch-2-HR strip`, `Ultritouch-4 strip`), and change the layout write:

```ts
        if (id && kind === "custom" && startFrom !== "blank") {
          const strip = startFrom.startsWith("ultritouch-") ? (startFrom as UltritouchModel) : null;
          const objects = strip ? ultritouchTemplate(strip) : startFrom === "dashboard" ? dashboardTemplate() : confidenceMonitorTemplate();
          await handlers.handleSetViewLayout(id, {
            version: 1,
            canvas: strip ? ultritouchCanvas(strip) : { width: 1920, height: 1080, background: null },
            objects,
          });
        }
```
Import `ultritouchTemplate, ultritouchCanvas, type UltritouchModel` from `../../editor/layout-editor` and re-export them from `layout-editor.tsx` line 109 beside the other two.

`layout-editor.tsx`: add a `startFromUltritouch(model: UltritouchModel)` beside `startFromConfidenceMonitor` that calls `pushHistory(); setCanvas(ultritouchCanvas(model)); setObjects(ultritouchTemplate(model)); setSelectedIds(new Set()); setDirty(true);` and three entries in the starters menu that lists Dashboard and Confidence Monitor (grep `startFromConfidenceMonitor` for the menu).

- [ ] **Step 5: Run, typecheck, drive**

```bash
node --import tsx --test renderer/editor/layout-templates.test.ts && npm run -s type-check && npm run -s lint
```
On a test server with an EMPTY data dir (Task 9's recipe): New view → console → "Ultritouch-2 strip" → Edit. Confirm eight buttons, one countdown, Letterbox locked. Resize the browser tall and wide: the strip keeps its shape. Kill by port.

- [ ] **Step 6: Docs and commit**

`docs/reference/layout-editor.md`: where starters are described (grep "Confidence Monitor" in the file), add "and three Ultritouch strips, one per panel, each a row of unbound cue buttons and a countdown on that panel's canvas."

```bash
git add renderer/editor/layout-templates.ts renderer/editor/layout-templates.test.ts renderer/editor/layout-editor.tsx renderer/settings/sections/new-view-dialog.tsx docs/reference/layout-editor.md
git commit -m "feat(layout-editor): Ultritouch strip starters" -m "Guard proven red: ultritouchTemplate did not exist. Counts are exact: 8 or 16 cue buttons plus one countdown."
```

### Task 11: The Ultritouch page

**Files:**
- Create: `docs/integrations/ultritouch.md`
- Modify: `docs/integrations/README.md` (table row)

- [ ] **Step 1: Write the page**

```markdown
# Ross Ultritouch

A Stage Utility console on a Ross Ultritouch panel, through DashBoard's Browser
component. Nothing on the panel is Stage Utility's own; the panel shows a web
page, and the page is a console sized to the panel's pixels.

## The panels

| Model | Display |
|---|---|
| Ultritouch-2 | 1366 x 203 |
| Ultritouch-2-HR | 1920 x 285 |
| Ultritouch-4 | 1366 x 485 |

From the Ultritouch User Guide (2201DR-304). PanelBuilder's own Ultritouch-2
template is 1304 wide, so the frame may take some width; the layout is
letterboxed, so a few pixels of background at the sides is the worst case.

## In Stage Utility

1. **Screens → New view → Custom Layout**, pick *A control surface you operate*,
   and start from the strip for your panel. The canvas is set to the panel's
   pixels with Letterbox fit locked: the layout keeps its shape and scales
   evenly wherever it is previewed, and never reflows.
2. **Edit** the console. Each starter button is a [cue button](../reference/widgets.md#control)
   with no cue yet; pick one in the inspector. Add, remove and resize as you like.
3. **Screens → New screen** for the panel, set its mode to **panel**, point it at
   the console, and turn on **Hide top bar**. Give it a slug, say `ultritouch`,
   so its address is `http://<server>/ultritouch`.

## In DashBoard

1. Open an existing `.grid` for the panel, or **File → New**, and turn on
   **Edit Mode**.
2. Choose the **Browser** tool and drag it across the whole canvas, edge to edge.
3. In its properties set **URL** to the screen's address, including `http://`,
   and **Type** to **CHROMIUM**.
4. Leave Edit Mode. The console shows in DashBoard on your computer at the
   panel's shape; that is what the panel will draw.
5. **File → Save As**, then on the Ultritouch's device page **Manage
   CustomPanels → Upload to Folder**, and open it from **Manage Open Views**.

## If the panel shows nothing

- The Browser **Type**: if CHROMIUM shows blank on the panel but not on your
  computer, the panel's DashBoard lacks it; try DEFAULT.
- The URL needs its scheme: `http://`, not `http:`.
- The screen must be in **panel** mode. A console on a display-mode screen is
  refused by the server, and a wall layout on a panel draws buttons that do
  nothing.
- **Hide top bar** off leaves the brand, plan and QR bar taking a quarter of a
  203-pixel strip.
```

`docs/integrations/README.md`: add a row `| [Ross Ultritouch](ultritouch.md) | A console on a Ross touch panel, through DashBoard's Browser component |` beside the RossTalk row.

- [ ] **Step 2: Docs guard**

If a test scans `docs/integrations/README.md` against the directory (grep `integrations/README` in `**/*.test.ts`), run it.

- [ ] **Step 3: Commit**

```bash
git add docs/integrations/ultritouch.md docs/integrations/README.md
git commit -m "docs(integrations): a console on a Ross Ultritouch"
```

---

## Gate before each PR

```bash
npm run -s type-check && npm run -s lint && npm test 2>&1 | tail -8
```
Expected: `fail 0`. Record the pass count in the PR body. Every PR body answers the two questions: what docs changed, and what an operator can read on `/log` (for B: the existing `[cues]` call line now says `console`).

## Self-review against the spec

- Presets, locked fit: Tasks 1–2. Cue button with five states: Tasks 6–8; unbound rendering: Task 8. Same-origin fire path: Task 5. One state source: Tasks 3–4 (`cues:all` beside `cues`, Home Assistant untouched). Capability table: Task 6. Templates per model with exact counts: Task 10. Docs page and the four reference edits: Tasks 1, 2, 3, 4, 5, 9, 10, 11. Logging: nothing new, stated in Task 9's commit and the PR body.
- Names used across tasks: `isUltritouchCanvas`, `canvasAfterPreset`, `ULTRITOUCH_PRESETS`, `ultritouchTemplate`, `ultritouchCanvas`, `UltritouchModel`, `useCueLive`, `cueEntry`, `applyCueEvent`, `CuesLive`, `cueButtonDeps`, `CUES_ALL_CHANNEL`, `cueLiveDeps.emitAll`, `cueManifest({ includeHidden })`. Each is defined in the task that first produces it.
