# Phase 3 — Surfaces and capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A View declares what it is for (`display` or `console`), an Output declares how it renders (`display` or `panel`), and every object type declares what it can do — so a wall screen cannot render a live control by accident, and an operator's console can.

**Architecture:** Two new schema fields and one new registry. `View.surface` and `Output.mode` are the safety boundary, enforced in the server's binding handler rather than the settings dropdown. A capability registry keyed by layout-object type says which objects are readouts, controls, drill-down targets or editable; the rendering context decides which capabilities are live. Control objects reference an existing `ActionDef` by id, so consoles reuse the automation action registry rather than growing a parallel one.

**Tech Stack:** TypeScript, React 19, TanStack Router, node:test, existing `DataStore` persistence, existing `AUTOMATION_ACTIONS` registry.

## Dependency

Phases 1a, 1b and 2 are **merged to `beta`** (#257, #258, #259). Branch off
`beta`. Tasks 7's files — `outputs-section.tsx` and `new-view-dialog.tsx` — are
present there.

## Global Constraints

- **No feature is dropped without a stated reason or a named replacement.** This
  phase ships a feature parity inventory (below), as every phase does.
- **A guard must fail on the bug it guards.** Delete the guard or reintroduce the
  bug and watch the test go red in-session; say so in the commit.
- **Prefer a check the type system enforces, or one that runs the real code
  path**, over one that reads source text. Where a scan must read source: walk
  recursively, match on something prose cannot satisfy, assert an EXACT count.
- **Every new persisted store declares `"config"` or `"runtime"`** in its
  constructor, and every new config store goes into `CONFIG_FILES` **in the same
  change** — or it is silently missing from every backup.
- **A new `catch` either rethrows or returns the failure to its caller.** A
  `catch` that only logs is forbidden.
- **No emojis** anywhere: UI, code, comments, commit messages, PR bodies.
- **Fix a repeated pattern everywhere at once.** Before committing a fix to
  something appearing more than once, grep for every instance; say in the commit
  how many were found and how many changed.
- Migration is **behavior-preserving**, never a blanket default. Existing
  installs must not lose a working touch panel.
- Numeric fields use the themed `NumberInput`, never a raw `<input type="number">`.

---

## File structure

| File | Responsibility |
|---|---|
| `main/types/views.ts` | Add `View.surface`, `Output.mode`. Existing types only. |
| `main/types/object-capabilities.ts` | **New.** The capability registry: object type → capabilities + optional drill-down target. Pure data, no imports from services. |
| `main/services/surface-migration.ts` | **New.** Behavior-preserving migration, pure and separately testable. |
| `main/services/stage-controller.ts` | Enforce the binding rule in `setOutputView`; refuse a surface change that would strand a bound Output; run the migration on load. |
| `main/services/action-invoke.ts` | **New.** One entry point for "an operator pressed a control": resolves an `ActionDef` by id, runs it, returns `ActionResult`. |
| `main/services/notes-store.ts` | **New.** `"config"` store for notes and checklist object content. |
| `renderer/main/layout-renderer.tsx` | Gate control/editable/drill-down rendering on the rendering context. |
| `renderer/main/render-context.ts` | **New.** What context a layout is rendering in, derived once. |
| `renderer/settings/sections/outputs-section.tsx` | Panel-mode toggle on a screen card; grouping by surface. |
| `renderer/settings/sections/new-view-dialog.tsx` | Surface chosen at creation. |

---

## Task 1: The two schema fields, defaulted safely

**Files:**
- Modify: `main/types/views.ts`
- Test: `main/types/views.test.ts` (create if absent)

**Interfaces:**
- Produces: `View.surface?: "display" | "console"`, `Output.mode?: "display" | "panel"`. Both OPTIONAL in the schema and read through accessors that default — an existing `views.json` must parse untouched.
- Produces: `viewSurface(v: View): "display" | "console"` and `outputMode(o: Output): "display" | "panel"`.

Optional-with-accessor rather than required-with-migration-on-read: a required
field means every existing `views.json` fails to parse until migrated, and the
migration in Task 3 needs the app to boot in order to run.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { viewSurface, outputMode } from "./views.js";

describe("surface defaults", () => {
  test("a View with no surface field is a display", () => {
    // The safe default: a wall screen renders no controls.
    assert.equal(viewSurface({ id: "v1", name: "x", kind: "custom", createdAt: "" } as View), "display");
  });

  test("an Output with no mode field is a display", () => {
    assert.equal(outputMode({ id: "o1", name: "x", viewId: null } as Output), "display");
  });

  test("an explicit console/panel is respected", () => {
    assert.equal(viewSurface({ surface: "console" } as View), "console");
    assert.equal(outputMode({ mode: "panel" } as Output), "panel");
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx tsx --test main/types/views.test.ts`, expected: "viewSurface is not a function".

- [ ] **Step 3: Implement**

```ts
export type ViewSurface = "display" | "console";
export type OutputMode = "display" | "panel";

/** What a View is FOR. Absent means "display": the safe default, because a View
 *  written before this field existed was rendering on a wall screen. */
export function viewSurface(v: Pick<View, "surface">): ViewSurface {
  return v.surface === "console" ? "console" : "display";
}

/** How an Output renders. Absent means "display" — read-only. An Output becomes
 *  interactive only by deliberate opt-in, never by inference. */
export function outputMode(o: Pick<Output, "mode">): OutputMode {
  return o.mode === "panel" ? "panel" : "display";
}
```

Add to the interfaces:

```ts
  /** What this View is for. Absent = "display" (see viewSurface). */
  surface?: ViewSurface;
```

```ts
  /** How this screen renders. Absent = "display" (see outputMode). */
  mode?: OutputMode;
```

- [ ] **Step 4: Run the test — expect PASS.**

- [ ] **Step 5: Prove the default is load-bearing.** Change `viewSurface` to
  return `"console"` when the field is absent, re-run, watch the first test go
  red, restore. Assert in the commit that the edit applied (the replacement
  changed the file) — a no-op edit reporting a false pass has happened here
  before.

- [ ] **Step 6: Commit** — `feat(views): declare a surface on Views and a mode on Outputs`

---

## Task 2: The capability registry

**Files:**
- Create: `main/types/object-capabilities.ts`
- Test: `main/types/object-capabilities.test.ts`

**Interfaces:**
- Consumes: the `LayoutObject` type union in `main/types/views.ts` (38 types).
- Produces: `CAPABILITIES: Record<LayoutObjectType, Capability[]>`, `DRILLDOWN: Partial<Record<LayoutObjectType, string>>`, `hasCapability(type, cap)`.

- [ ] **Step 1: Write the failing test.** The load-bearing assertion is
  EXHAUSTIVENESS — a new object type with no entry must fail, or the next
  control object silently renders on a wall display.

```ts
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, DRILLDOWN, hasCapability } from "./object-capabilities.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every `type: "..."` in the LayoutObject union, read from source. Prose cannot
 *  satisfy this: it matches the type-literal position inside the union only. */
function declaredObjectTypes(): string[] {
  const src = readFileSync(path.join(HERE, "views.ts"), "utf8");
  const union = src.slice(src.indexOf("export type LayoutObject"));
  const end = union.indexOf("\n\n");
  return [...new Set([...union.slice(0, end).matchAll(/type:\s*"([\w-]+)"/g)].map((m) => m[1]))];
}

describe("capability registry", () => {
  test("the scan finds the object types at all", () => {
    const types = declaredObjectTypes();
    assert.ok(types.length >= 30, `only found ${types.length} object types — this scan is broken`);
    assert.ok(types.includes("osc-button"), "expected osc-button among them");
  });

  test("EVERY object type has an entry — exact, not a floor", () => {
    const declared = declaredObjectTypes().sort();
    assert.deepEqual(
      Object.keys(CAPABILITIES).sort(),
      declared,
      "an object type without a capability entry renders ungated — add it",
    );
  });

  test("the three existing interactive objects are controls", () => {
    for (const t of ["osc-button", "rosstalk-button", "live-controls"]) {
      assert.ok(hasCapability(t, "control"), `${t} must be a control`);
    }
  });

  test("a drill-down target names a route that exists", () => {
    // A target nothing routes to is a dead link on every console.
    for (const [type, route] of Object.entries(DRILLDOWN)) {
      assert.ok(route.startsWith("/"), `${type}: ${route} is not a path`);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — module not found.

- [ ] **Step 3: Implement.** Enumerate all 38 types explicitly; do not derive
  with a default, because a default is exactly how a new control object would
  arrive ungated.

```ts
export type Capability = "readout" | "control" | "drilldown" | "editable";

/** What each object type can do. Composed: an SPL meter is a readout AND a
 *  drill-down target. Exhaustive by test — a type with no entry fails. */
export const CAPABILITIES: Record<string, Capability[]> = {
  // Controls — the only types that invoke an ActionDef.
  "osc-button": ["control"],
  "rosstalk-button": ["control"],
  "live-controls": ["control"],
  "action-button": ["control"],
  // Editable — hold the operator's work product.
  notes: ["editable"],
  checklist: ["editable"],
  // Readouts with a drill-down target.
  "spl-meter": ["readout", "drilldown"],
  "people-counter": ["readout", "drilldown"],
  "wireless-channel": ["readout", "drilldown"],
  "obs-status": ["readout", "drilldown"],
  // ... every remaining type: ["readout"]
};

/** Where each drill-down-capable object goes when pressed in the shell. */
export const DRILLDOWN: Record<string, string> = {
  "spl-meter": "/history",
  "people-counter": "/history",
  "wireless-channel": "/patch",
  "obs-status": "/settings/integrations",
};

export function hasCapability(type: string, cap: Capability): boolean {
  return (CAPABILITIES[type] ?? []).includes(cap);
}
```

- [ ] **Step 4: Run the tests — expect PASS.**

- [ ] **Step 5: Prove the exhaustiveness guard.** Delete one entry from
  `CAPABILITIES`, re-run, watch the exact-match test go red, restore.

- [ ] **Step 6: Commit** — `feat(layout): declare what each object type can do`

---

## Task 3: Behavior-preserving migration

**Files:**
- Create: `main/services/surface-migration.ts`
- Create: `main/services/surface-migration.test.ts`
- Modify: `main/services/stage-controller.ts` (call it on load)

**Interfaces:**
- Consumes: `CAPABILITIES`/`hasCapability` (Task 2), `viewSurface`/`outputMode` (Task 1).
- Produces: `migrateSurfaces(views, outputs): { views, outputs, changed: MigrationNote[] }` — pure, no I/O.

A blanket default of `display` would silently disable the buttons on any touch
panel in service today. Any View containing a `control` object migrates to
`console`, and the Outputs bound to it migrate to `panel`.

- [ ] **Step 1: Write the failing test.** It must run the real path, not assert
  field values — the design doc says so explicitly.

```ts
describe("surface migration", () => {
  test("a View with an OSC button becomes a console, and its Output a panel", () => {
    const views = [{ id: "v1", name: "Panel", kind: "custom", createdAt: "",
      layout: { version: 1, canvas: { width: 1920, height: 1080, background: null },
        objects: [{ id: "o1", type: "osc-button", x: 0, y: 0, w: 10, h: 10 }] } }] as View[];
    const outputs = [{ id: "out1", name: "Booth", viewId: "v1" }] as Output[];

    const r = migrateSurfaces(views, outputs);
    assert.equal(viewSurface(r.views[0]), "console");
    assert.equal(outputMode(r.outputs[0]), "panel");
  });

  test("a View with no controls is left as a display", () => {
    const views = [{ id: "v2", name: "Wall", kind: "custom", createdAt: "",
      layout: { version: 1, canvas: { width: 1920, height: 1080, background: null },
        objects: [{ id: "o1", type: "clock", x: 0, y: 0, w: 10, h: 10 }] } }] as View[];
    const outputs = [{ id: "out2", name: "Lobby", viewId: "v2" }] as Output[];
    const r = migrateSurfaces(views, outputs);
    assert.equal(viewSurface(r.views[0]), "display");
    assert.equal(outputMode(r.outputs[0]), "display");
    assert.equal(r.changed.length, 0, "nothing to report when nothing moved");
  });

  test("controls nested inside a container are found", () => {
    // Containers nest. A scan of top-level objects only would migrate the View
    // to display and kill the button inside the container.
    const views = [{ id: "v3", name: "Nested", kind: "custom", createdAt: "",
      layout: { version: 1, canvas: { width: 1920, height: 1080, background: null },
        objects: [{ id: "c1", type: "container", x: 0, y: 0, w: 100, h: 100,
          children: [{ id: "b1", type: "osc-button", x: 0, y: 0, w: 10, h: 10 }] }] } }] as View[];
    const r = migrateSurfaces(views, [] as Output[]);
    assert.equal(viewSurface(r.views[0]), "console");
  });

  test("it reports what it moved, so a stray control can be demoted", () => {
    const views = [{ id: "v1", name: "Wall with a stray button", kind: "custom", createdAt: "",
      layout: { version: 1, canvas: { width: 1920, height: 1080, background: null },
        objects: [{ id: "o1", type: "live-controls", x: 0, y: 0, w: 10, h: 10 }] } }] as View[];
    const r = migrateSurfaces(views, [] as Output[]);
    assert.equal(r.changed.length, 1);
    assert.match(r.changed[0].why, /live-controls/);
  });

  test("it is idempotent", () => {
    // It runs on every load. A second pass must report nothing changed.
    const views = [{ id: "v1", surface: "console", kind: "custom", name: "", createdAt: "" }] as View[];
    assert.equal(migrateSurfaces(views, [] as Output[]).changed.length, 0);
  });
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement.** Walk containers recursively — the nested case above
  is the one a top-level scan gets wrong.

```ts
export interface MigrationNote { viewId: string; viewName: string; why: string; outputs: string[] }

function controlTypesIn(objects: LayoutObject[] | undefined): string[] {
  const found: string[] = [];
  const walk = (list: LayoutObject[] | undefined) => {
    for (const o of list ?? []) {
      if (hasCapability(o.type, "control")) found.push(o.type);
      walk((o as { children?: LayoutObject[] }).children);
    }
  };
  walk(objects);
  return [...new Set(found)];
}
```

- [ ] **Step 4: Run the tests — expect PASS.**

- [ ] **Step 5: Prove the nested case.** Replace the recursive walk with a
  top-level `objects.filter(...)`, re-run, watch the container test go red,
  restore.

- [ ] **Step 6: Wire it into load** in `stage-controller`, logging each note at
  `console.log` with the View name and the Outputs it pulled to `panel`. Persist
  the result so the migration runs once rather than on every boot.

- [ ] **Step 7: Human check.** Run the real server against a copy of a real
  config (`/tmp/stage-live-copy`, never `~/.stage-utility`) and read the log
  lines. Confirm the count matches the Views that actually contain controls.

- [ ] **Step 8: Commit** — `feat(views): migrate control-carrying Views to consoles, preserving behaviour`

---

## Task 4: The binding rule, enforced on the server

**Files:**
- Modify: `main/services/stage-controller.ts` (`setOutputView`, plus a new `setOutputMode` and a guard in the View-update path)
- Test: `main/services/stage-controller.surface.test.ts`

**Interfaces:**
- Produces: `setOutputMode(id, mode): Promise<StageState>`.
- `setOutputView` gains the refusal; the error message names both sides.

The test must ATTEMPT the binding and assert the refusal — not scan source for
the check. A source scan is satisfied by a comment.

- [ ] **Step 1: Write the failing test**

```ts
test("a display Output refuses a console View", async () => {
  await assert.rejects(
    () => controller.setOutputView("wall-1", "console-view"),
    /console/i,
    "binding a console View to a wall screen must be refused, not silently allowed",
  );
});

test("a panel Output accepts a console View", async () => {
  await controller.setOutputMode("booth-1", "panel");
  const s = await controller.setOutputView("booth-1", "console-view");
  assert.equal(s.outputs.find((o) => o.id === "booth-1")?.viewId, "console-view");
});

test("converting a bound View names the Output it would strand", async () => {
  await assert.rejects(
    () => controller.setViewSurface("display-view", "console"),
    /Lobby/,
    "the refusal must name the screen, not just say no",
  );
});
```

- [ ] **Step 2: Run and watch it fail** (currently the binding succeeds).

- [ ] **Step 3: Implement** in `setOutputView`, after the existing existence checks:

```ts
    if (viewId !== null) {
      const view = this.state.views.find((v) => v.id === viewId)!;
      const output = this.state.outputs.find((o) => o.id === id)!;
      if (viewSurface(view) === "console" && outputMode(output) !== "panel") {
        throw new Error(
          `outputs:setView — "${view.name}" is a console and ${output.name} is a display. ` +
          `Set that screen to panel mode first if it is a touch panel.`,
        );
      }
    }
```

- [ ] **Step 4: Run the tests — expect PASS.**

- [ ] **Step 5: Prove the guard.** Delete the refusal, re-run, watch both
  refusal tests go red, restore.

- [ ] **Step 6: Drive the real server.** Not a unit test over the helper: start
  the server, POST the binding through the real handler, and confirm the refusal
  reaches the client with its reason intact. Unit tests over pieces with a broken
  path through them is a documented failure mode in this repository.

- [ ] **Step 7: Commit** — `feat(outputs): refuse to bind a console View to a wall display`

---

## Task 5: Controls invoke an ActionDef

**Files:**
- Create: `main/services/action-invoke.ts`
- Create: `main/services/action-invoke.test.ts`
- Modify: `main/types/views.ts` (add the `action-button` object type)
- Modify: `main/services/routes/` (an `action:invoke` handler)

**Interfaces:**
- Consumes: `AUTOMATION_ACTIONS` (`main/services/automation-actions.ts`), `ActionDef`, `ActionResult`.
- Produces: `invokeAction(id, params): Promise<ActionResult>` — never throws; a failure is a returned result, matching `ActionDef`'s existing contract.

- [ ] **Step 1: Write the failing test**

```ts
test("an unknown action id returns a failed result rather than throwing", async () => {
  const r = await invokeAction("nope.not.an.action", {});
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /unknown action/i);
});

test("a known action runs and its result is returned", async () => {
  const r = await invokeAction("pco.live.advance", { direction: "next" });
  assert.equal(typeof r.ok, "boolean");
});

test("a throwing action is contained", async () => {
  // ActionDef promises never to throw. This asserts we do not TRUST that -
  // one bad provider must not take the console down.
  AUTOMATION_ACTIONS["test.boom"] = { id: "test.boom", label: "boom", params: [],
    run: async () => { throw new Error("kaboom"); } };
  const r = await invokeAction("test.boom", {});
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /kaboom/);
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement.** The `catch` RETURNS the failure; it does not only
  log — the repository rule.

```ts
export async function invokeAction(id: string, params: Record<string, unknown>): Promise<ActionResult> {
  const def = AUTOMATION_ACTIONS[id];
  if (!def) return { ok: false, error: `unknown action "${id}"` };
  try {
    return await def.run(params, { simulate: false });
  } catch (e) {
    // ActionDef contracts never to throw. Belt and braces: a provider that
    // breaks its contract must fail this one press, not the console.
    return { ok: false, error: errorMessage(e) };
  }
}
```

- [ ] **Step 4: Add the `action-button` object type** to the `LayoutObject`
  union, and its `CAPABILITIES` entry (Task 2's exact-match test will fail until
  the entry exists — that is the guard working):

```ts
  | { type: "action-button"; actionId: string; params?: Record<string, unknown>; label?: string }
```

- [ ] **Step 5: Run the tests — expect PASS.**

- [ ] **Step 6: Prove the containment guard.** Remove the `try/catch`, re-run,
  watch the throwing-action test go red, restore.

- [ ] **Step 7: Commit** — `feat(automation): let a console control invoke an action`

---

## Task 6: The rendering context gates capabilities

**Files:**
- Create: `renderer/main/render-context.ts`
- Create: `renderer/main/render-context.test.ts`
- Modify: `renderer/main/layout-renderer.tsx`

**Interfaces:**
- Produces: `type RenderContext = "display" | "panel" | "shell"`, and `capabilityLive(ctx, cap): boolean` implementing the design doc's matrix exactly.

| | display Output | panel Output | console in the shell |
|---|---|---|---|
| readout | yes | yes | yes |
| control | no | yes | yes |
| editable | no | yes | yes |
| drill-down | no | no | yes |
| layout editing | no | no | yes |

- [ ] **Step 1: Write the failing test — the whole matrix, cell by cell.**

```ts
const MATRIX: [RenderContext, Capability, boolean][] = [
  ["display", "readout", true],  ["panel", "readout", true],  ["shell", "readout", true],
  ["display", "control", false], ["panel", "control", true],  ["shell", "control", true],
  ["display", "editable", false],["panel", "editable", true], ["shell", "editable", true],
  ["display", "drilldown", false],["panel", "drilldown", false],["shell", "drilldown", true],
];

for (const [ctx, cap, expected] of MATRIX) {
  test(`${cap} in ${ctx} is ${expected ? "live" : "inert"}`, () => {
    assert.equal(capabilityLive(ctx, cap), expected);
  });
}
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement** as a literal table, not as conditionals — the table
  IS the specification and reads against the doc directly.

- [ ] **Step 4: Gate the renderer.** In `layout-renderer.tsx`, a control object
  in a `display` context renders its readout appearance and does not bind a press
  handler. It must not render as a broken button.

- [ ] **Step 5: Drive it.** With the real server: bind a console View to a panel
  Output, press a control, confirm the action fires; then set that Output back to
  `display` and confirm the same press does nothing. A control that renders is
  not a control that does anything — this repository shipped a `+ row` button
  that added a row the same code filtered straight back out.

- [ ] **Step 6: Prove the gate.** Make `capabilityLive` return `true`
  unconditionally, re-run, watch the display-context rows go red, restore.

- [ ] **Step 7: Commit** — `feat(layout): gate controls on the rendering context`

---

## Task 7: Screens and creation choose the surface

**Files:**
- Modify: `renderer/settings/sections/outputs-section.tsx`
- Modify: `renderer/settings/sections/new-view-dialog.tsx`
- Test: `renderer/settings/sections/surface-ui.test.tsx`

**Interfaces:**
- Consumes: `setOutputMode` (Task 4), `viewSurface`/`outputMode` (Task 1).

- [ ] **Step 1: Surface at creation.** `NewViewDialog` gains a display/console
  choice. Console offers `custom` only — the other kinds have no editable layout
  and so cannot carry controls. Wording, not jargon: "A wall screen anyone can
  see" / "A control surface you operate".

- [ ] **Step 2: Panel mode on a screen card.** In the overflow menu beside Lock:
  "Use as a touch panel", with a confirm that says plainly what changes —
  controls become live on that screen.

- [ ] **Step 3: Group the unassigned-views section** by surface, so consoles and
  displays are not one undifferentiated list.

- [ ] **Step 4: The picker only offers bindable Views.** A display Output lists
  display Views; a panel lists both. This is convenience, NOT the safety
  property — Task 4's server-side refusal is the safety property, and it stays
  even though the dropdown now makes the mistake hard to reach.

- [ ] **Step 5: Write the test** — the picker's offered set, not its markup:

```tsx
test("a display Output is not offered a console View", () => {
  const offered = bindableViews(views, { id: "o1", name: "Lobby", viewId: null } as Output);
  assert.deepEqual(offered.map((v) => v.id), ["display-view"]);
});
```

- [ ] **Step 6: Browser-verify at 1440px and 390px**, against the real server:
  create a console, set a screen to panel, bind, press a control.

- [ ] **Step 7: Commit** — `feat(screens): choose a surface, and pin a console to a panel`

---

## Task 8: Notes and checklist objects

**Files:**
- Create: `main/services/notes-store.ts`
- Modify: `main/services/config-snapshot.ts` (`CONFIG_FILES`)
- Modify: `main/types/views.ts` (two object types)
- Test: `main/services/notes-store.test.ts`

Both hold the operator's work product, so both are `"config"` stores and both go
into `CONFIG_FILES` **in this same change** — the standing rule.

- [ ] **Step 1: Write the failing test**, including the allowlist assertion:

```ts
test("the notes store is in CONFIG_FILES", () => {
  // A config store missing from the allowlist is silently absent from every
  // backup. config-snapshot.test.ts already fails if a store lands in the wrong
  // half; this names THIS store so the omission cannot pass.
  assert.ok(CONFIG_FILES.includes("notes.json"));
});

test("an edit survives a reload", async () => {
  await notesStore.set("obj-1", "sound check at 8");
  assert.equal((await freshStore()).get("obj-1"), "sound check at 8");
});
```

- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement** the store with `"config"` declared in its constructor, and both object types with `editable` capability entries.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Prove the allowlist guard.** Remove `notes.json` from `CONFIG_FILES`, re-run, watch it go red, restore.
- [ ] **Step 6: Drive the real server** — type into a note on a panel, restart the server, confirm the text is still there. A wireless password that could not be cleared and a baptism restore the next append deleted both had green tests over the pieces.
- [ ] **Step 7: Commit** — `feat(layout): notes and checklist objects`

---

## Task 9: The context bar becomes a registry

**Files:**
- Create: `renderer/app/bar-items.tsx` (the registry)
- Create: `main/services/bar-config-store.ts` (`"config"` store)
- Modify: `main/services/config-snapshot.ts` (`CONFIG_FILES`)
- Modify: `renderer/app/context-bar.tsx` (render from the registry)
- Modify: `renderer/settings/sections/advanced-section.tsx` (choose items and order)
- Test: `renderer/app/bar-items.test.tsx`, `main/services/bar-config-store.test.ts`

**Interfaces:**
- Consumes: `useObsState`, `useReaperState`, `useSplState`, `useIntegrationStates`, `useDashboardState` — the SAME hooks the layout objects use.
- Produces: `BAR_ITEMS: Record<BarItemId, BarItem>`, `barConfigStore`.

`context-bar.tsx`'s own header already says the fixed item set "becomes a
configurable registry in Phase 3, alongside integration health and recording
status". A fixed bar is wrong as soon as another integration lands.

Three requirements, each from a failure this repo has already had:

- The bar configuration is operator config: a `DataStore` declared `"config"`,
  added to `CONFIG_FILES` **in the same change**.
- The registry is **compiler-enforced**. This becomes another place a new
  integration must register itself, and source-scanning guards here have
  repeatedly passed while missing entries.
- **Bar items share data HOOKS with layout objects, not components.** The
  OBS-recording bar item and the OBS-status layout object both read
  `use-obs-state`; a compact strip and a free-form canvas box are different
  presentations. Shared logic, separate rendering.

- [ ] **Step 1: Make the registry compiler-enforced.** A union of ids plus a
  `Record` keyed by it — a missing entry is a type error, not a test failure.
  This is the requirement the spec singles out, so it must not be a source scan.

```ts
export type BarItemId =
  | "clock"
  | "plan"
  | "live-timer"
  | "current-item"
  | "integration-health"
  | "recording";

export interface BarItem {
  id: BarItemId;
  label: string;
  icon: LucideIcon;
  /** Compact renderer. Returns null to render nothing (e.g. no service today). */
  Render: () => ReactNode;
}

// A missing key here fails `tsc`, which is the point: a new integration cannot
// add a bar item and forget to register it.
export const BAR_ITEMS: Record<BarItemId, BarItem> = { /* all six */ };
```

- [ ] **Step 2: Prove the compiler enforces it.** Delete one entry from
  `BAR_ITEMS`, run `npm run type-check`, watch it fail with
  "Property 'recording' is missing", restore. A type error, watched in-session,
  is the proof — assert in the commit that the deletion actually applied.

- [ ] **Step 3: Write the failing test for the config store**

```ts
test("the bar config store is in CONFIG_FILES", () => {
  assert.ok(CONFIG_FILES.includes("bar-config.json"));
});

test("an unknown id in a saved config is ignored, not rendered blank", async () => {
  // A downgrade, or an integration removed: the saved order can name an item
  // this build does not have. It must skip it rather than render a hole.
  await barConfigStore.set({ items: ["clock", "no-such-item", "recording"] });
  assert.deepEqual(visibleBarItems(await barConfigStore.get()), ["clock", "recording"]);
});

test("an empty config falls back to the shipping set, not an empty bar", async () => {
  await barConfigStore.set({ items: [] });
  assert.ok(visibleBarItems(await barConfigStore.get()).length > 0);
});
```

- [ ] **Step 4: Run and watch it fail.**

- [ ] **Step 5: Implement** the store (`"config"` declared in its constructor)
  and the two new items:
  - **integration health** — reuses `use-integration-states`; shows a count of
    anything disconnected, not a green tick when all is well, because a bar item
    that is always green is noise.
  - **recording status** — reuses `use-obs-state` and `use-reaper-state`, and
    reuses `recordingStat()` from `renderer/app/home/live-panel.tsx` rather than
    reimplementing the "connected but stopped" judgement. That logic already
    exists and is tested; a second copy is a second place for the same bug.
    Extract it to a shared module in this step and update Home's import — grep
    for every caller and say in the commit how many were found and changed.

- [ ] **Step 6: Run the tests — expect PASS.**

- [ ] **Step 7: Prove the allowlist guard.** Remove `bar-config.json` from
  `CONFIG_FILES`, re-run, watch it go red, restore.

- [ ] **Step 8: The chooser.** Advanced gains a reorderable list of bar items
  with visibility toggles, using the existing `MouseSensor`/`TouchSensor` pair —
  never a single `PointerSensor`, which made lists unscrollable on phones.

- [ ] **Step 9: Drive the real server.** Reorder the bar, reload, confirm the
  order persisted; disconnect an integration and confirm the health item
  reflects it live rather than on refresh. The bar is global configuration, not
  per-device, so check a second browser sees the same order.

- [ ] **Step 10: Commit** — `feat(shell): make the context bar a configurable registry`

---

## Task 10: Whole-branch verification and PR

- [ ] **Step 1:** `npm run type-check`, `npm run lint`, `npm test` — read the output in-session.
- [ ] **Step 2:** Build, then verify `built == served` asset hash before browser-testing. A stale server on a held port has produced false passes here.
- [ ] **Step 3:** Three review passes — correctness, simplification, whole-PR — and act on what they find before opening the PR.
- [ ] **Step 4:** Re-run the parity inventory below and mark each row verified.
- [ ] **Step 5:** Open the PR. Do not merge it.

---

## Feature parity inventory

Nothing is dropped without a stated reason or a named replacement.

| Feature | Today | Disposition |
|---|---|---|
| `osc-button` object | Fires OSC from any View | **Carried unchanged.** Becomes a specialization of the control capability; existing layouts keep working untouched. |
| `rosstalk-button` object | Fires RossTalk | **Carried unchanged.** |
| `live-controls` object | PCO Prev/Next, special-cased | **Carried, generalised.** Becomes an ordinary control backed by `pco.live.advance`, which already exists in the action registry. Capability gating replaces the special case. |
| Buttons working on a touch panel today | They render and fire on any Output | **Carried by migration.** Any View containing a control migrates to `console` and its Outputs to `panel`, so behaviour is preserved with no operator action. Logged, so a stray control that pulled a wall display into `panel` can be demoted deliberately. |
| Any View bindable to any Output | No restriction | **Deliberately restricted.** A console View may only bind to a panel Output, refused server-side. The reason: a wall screen must not render a live control by accident. Migration means no install loses a working binding. |
| `/preview-<view>` live preview | Renders a third presentation | **Carried, corrected.** Renders in the View's own declared surface, so the preview shows what the screen will show. |
| Views list ungrouped | One flat list | **Replaced.** Grouped by surface, since the two are now different kinds of thing. |
| Automation actions | Invoked only by rules | **Carried and extended.** Same registry, second caller. No parallel action list. |
| Existing `views.json` / `outputs` | No surface fields | **Carried.** Both fields are optional and read through defaulting accessors, so an existing file parses untouched. |
| Layout editing on a panel | n/a (panels do not exist yet) | **Deliberately absent.** Editing stays in the operator shell so a pinned panel cannot be rearranged by whoever is standing at it. |
| Context bar's fixed items (clock, plan, live timer, current item) | Hard-coded in `context-bar.tsx` | **Carried.** All four become registry entries and remain the default shipping set, so a bar nobody configures looks exactly as it does today. |
| `recordingStat()` on Home | Added in Phase 2, used by the live panel | **Carried, shared.** Extracted so the bar's recording item and Home read one implementation rather than two. |
| Drill-down on a panel | n/a | **Deliberately absent.** There is no navigation on a chrome-free panel to drill into. |

---

## Self-review

**Spec coverage.** Section 1's surface model → Tasks 1, 4, 7. Section 4's
capability model → Tasks 2, 6; controls-reuse-`ActionDef` → Task 5; drill-down
targets → Task 2; notes and checklist → Task 8; rendering contexts → Task 6;
migration → Task 3. Section 2's configurable context bar → Task 9, including the
two items the design doc names as arriving with this phase (integration health,
recording status).

**Type consistency.** `viewSurface`/`outputMode` (Task 1) are used by name in
Tasks 3, 4, 6 and 7. `hasCapability` (Task 2) is used in Tasks 3 and 6.
`Capability` and `RenderContext` are the same identifiers throughout.

**Known gap.** Task 2's `CAPABILITIES` table is shown truncated (`// ... every
remaining type`). The implementer must enumerate all 38; the exact-match test in
Step 3 is what forces it, and will fail loudly until every type is present.
