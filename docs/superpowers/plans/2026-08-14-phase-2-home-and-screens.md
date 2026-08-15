# Phase 2 — Home and Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a live home at the root URL instead of a link list, and merge Views and Outputs into one Screens surface.

**Architecture:** Home is a fixed arrangement of the widget set, with two states driven by whether PCO reports a service live. It reuses History's existing derivations rather than recomputing them, and drills into History rather than duplicating it. Screens presents Outputs and Views together — a card per physical screen showing what it displays and whether it is online — without touching the Views/Outputs data model, which is correct.

**Tech Stack:** React 19, TypeScript, `@tanstack/react-router`, `@tanstack/react-query`, Tailwind v4, `node --test` with `tsx`, jsdom via `renderer/test-dom.ts`.

**Depends on:** Phases 1a (#257) and 1b (#258). Branch from `feat/dissolve-settings` until those merge.

## Global Constraints

- **No emojis anywhere** — source, UI copy, comments, commit messages, PR bodies.
- **No direct pushes.** Branch, open a PR, let the maintainer merge.
- **Every `catch` rethrows or returns the failure to its caller.**
- **A guard must fail on the bug it guards** — reintroduce the bug, watch it go red, and verify the edit actually applied. A silent no-op replace once reported a false pass.
- **Prod is not a secure context.** Guard `crypto.randomUUID`, clipboard write, service workers.
- **Numeric fields use the themed `NumberInput`.**
- **Dark surfaces are strictly R=G=B neutral.**
- **DOM tests call `installDom()` at module top level, then `await import(...)`.** It now exposes Web Storage; do not rely on Node's globals, which differ between this machine and CI.
- **Verify before claiming.** `lint`, `type-check`, `test`, `build`, then drive the real server — and confirm the served asset hash matches the local build before trusting any URL check.

---

## Feature parity inventory

Built by reading `display-picker-view.tsx` (161 lines), `views-section.tsx` (576),
`outputs-section.tsx` (344) and `plan-section.tsx` (219).

Home **replaces** the display picker at `/`, so every one of the picker's jobs
needs a home. A row marked carried is checked in a browser at desktop and phone
widths — Phase 1a marked the mobile drawer carried without ever resizing the
window, and a phone got an undismissable sidebar.

### The display picker, which Home replaces

| Feature | Disposition |
|---|---|
| Loading state (spinner) | **Carried.** |
| Error state — "Could not load displays" with the reason | **Carried.** The reason is shown, not swallowed. |
| Brand top bar: logo + app name | **Replaced.** The shell's rail carries brand; Home is inside the shell. |
| QR linking to `/settings` | **Carried, relocated.** It belongs with Connect, which is where an operator goes to share a link. Home shows the address as part of readiness. |
| Centred empty-slot logo | **Carried** on the commissioning screen, which is where it made sense — a monitor waiting to be told what it is. |
| Display list from `state.outputs` | **Carried** into "Use this screen as a display". |
| Per-icon tints from `state.iconColors[id]` | **Carried.** Set from Displays/Connect and keyed by display id or tool path; dropping them would silently discard a colour an operator chose. |
| Operator tool tiles (ScriptView, Baptisms, Patch, History) | **Replaced by the rail.** They are destinations now; a second list of the same links on Home is the duplication this redesign exists to remove. |
| `/log` deliberately absent | **Preserved as a decision.** It is an operator diagnostic, not a volunteer destination, and stays off Home too. |

### Views and Outputs, merging into Screens

| Feature | Disposition |
|---|---|
| Views list with add/rename/duplicate/remove | **Carried**, unchanged handlers, rehomed onto Screens. Manual **reorder** was dropped on purpose — only the view picker read the order, which now sorts by name. See the design doc. |
| View kind switching, slots layout, layout editing | **Carried.** |
| Slot editor, presets, templates, live preview | **Carried.** Untouched — merging is presentation only. |
| Outputs list with assign/lock/remove/reorder/refresh | **Carried.** |
| Output online/offline presence | **Carried and promoted.** `presenceSnapshot()` and the `displays:presence` channel already exist; the card shows it rather than burying it. |
| Views/Outputs data model | **Unchanged.** A View is content, an Output is a screen, one View drives many Outputs. This merges the two *surfaces*, not the model. |

### Plan, folding into Home

| Feature | Disposition |
|---|---|
| Service type + plan selection | **Carried.** Moves to Home and stays in the context bar. |
| Auto/manual plan mode, next plan, refresh | **Carried.** |
| Getting Started onboarding | **Carried**, with its flash targets. |
| Allowed service types | **Carried.** |
| `/plan` as a route | **Dropped, with reason.** Its content is Home's. `/plan` redirects to `/`, so a Getting Started link or a bookmark still lands. |

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `renderer/app/home/home-route.tsx` | Home: picks live or idle. |
| `renderer/app/home/live-panel.tsx` | Timer, current item, recording, SPL, outputs online. |
| `renderer/app/home/idle-panel.tsx` | Next service, plan summary, readiness. |
| `renderer/app/home/readiness.ts` | `readinessChecks(state)` — pure, testable. |
| `renderer/app/home/readiness.test.ts` | Each check, including the not-yet-knowable cases. |
| `renderer/app/home/commission.tsx` | "Use this screen as a display" — the picker's job. |
| `renderer/app/screens/screens-route.tsx` | Outputs and Views on one surface. |
| `renderer/app/home/home.test.tsx` | Live/idle selection; `/plan` redirect. |

**Modified**

| File | Change |
|---|---|
| `renderer/app/destinations.tsx` | Home at `/`; Screens replaces Views + Displays; Plan removed. |
| `renderer/app/router.tsx` | `/` route; `/plan` redirect. |
| `main/services/routes/operator-paths.ts` | `/screens`; `/plan` kept for the redirect. |
| `renderer/main/root-view.tsx` | Kiosk keeps `/display-N` only; `/` belongs to the operator app. |
| `main/services/remote-server.ts` | `/` resolves to `app.html`; `/display-N` stays kiosk. |

**Deleted**

| File | Why |
|---|---|
| `renderer/main/display-picker-view.tsx` | Its commissioning job moves to `commission.tsx`; its tool tiles are the rail. |

---

## Task 1: Readiness, as a pure function

**Files:** Create `renderer/app/home/readiness.ts`, `renderer/app/home/readiness.test.ts`

**Produces:** `readinessChecks(state: StageState, presence: string[]): ReadinessCheck[]` where `ReadinessCheck = { id, label, ok, detail, route?, flash? }`.

"What is not ready for Sunday" is the question the app cannot currently answer.
Pure so it is testable without rendering, and so each check can say what to do
about it rather than only that it failed.

- [ ] **Step 1: Write the failing test**

```ts
// renderer/app/home/readiness.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readinessChecks } from "./readiness.js";

const base = {
  pcoConfigured: true,
  planId: "p1",
  planTitle: "Sunday",
  serviceTypeName: "Weekend",
  views: [{ id: "v1" }, { id: "v2" }],
  outputs: [{ id: "d1", viewId: "v1" }],
} as unknown as StageState;

describe("readiness", () => {
  test("a fully configured machine reports everything ready", () => {
    const checks = readinessChecks(base, ["d1"]);
    assert.ok(checks.every((c) => c.ok), checks.filter((c) => !c.ok).map((c) => c.id).join(", "));
  });

  test("names PCO when it is not configured", () => {
    const c = readinessChecks({ ...base, pcoConfigured: false } as StageState, ["d1"]);
    const pco = c.find((x) => x.id === "pco");
    assert.equal(pco?.ok, false);
    // A check that only says "not ready" leaves the operator hunting. Each one
    // carries where to go.
    assert.ok(pco?.route, "a failing check must say where to fix it");
  });

  test("an output that is not online is not ready", () => {
    const c = readinessChecks(base, []);
    assert.equal(c.find((x) => x.id === "outputs")?.ok, false);
  });

  test("an output with no View assigned is not ready", () => {
    const c = readinessChecks(
      { ...base, outputs: [{ id: "d1", viewId: null }] } as unknown as StageState,
      ["d1"],
    );
    assert.equal(c.find((x) => x.id === "outputs")?.ok, false);
  });

  test("reports no plan rather than throwing when PCO is unconfigured", () => {
    // A fresh install has no plan AND no PCO. The plan check must degrade to
    // "not ready" instead of blowing up the whole home page on first run,
    // which is the only time anyone sees it.
    const c = readinessChecks(
      { ...base, pcoConfigured: false, planId: null, planTitle: null } as StageState,
      [],
    );
    assert.ok(Array.isArray(c) && c.length > 0);
    assert.equal(c.find((x) => x.id === "plan")?.ok, false);
  });

  test("every check has a stable id and a human label", () => {
    // The ids key the UI; a duplicate would render one check twice and hide
    // another.
    const c = readinessChecks(base, ["d1"]);
    assert.equal(new Set(c.map((x) => x.id)).size, c.length);
    for (const x of c) assert.ok(x.label.length > 0, `${x.id} has no label`);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — module not found.
- [ ] **Step 3: Implement** `readinessChecks`, covering: PCO configured, a plan selected, at least one View beyond the shipped default, every Output assigned a View, every Output online. Each failing check carries `route` (and `flash` where a specific control fixes it) so Home can link straight at it — the mechanism Phase 1b built.
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Prove a guard** — make a failing check return no `route`; the "must say where to fix it" test reddens. Confirm the edit applied before believing the result.
- [ ] **Step 6: Commit.**

---

## Task 2: Home, live and idle

**Files:** Create `renderer/app/home/home-route.tsx`, `live-panel.tsx`, `idle-panel.tsx`, `home.test.tsx`

**Consumes:** `contextBarState`-style liveness from `computePcoTimer`, `useStageSettings()`, `readinessChecks`.

A dashboard that looks the same on a Tuesday and mid-service is reporting rather
than participating.

- [ ] **Step 1: Write the failing test** — assert the live/idle *decision*, not markup:

```tsx
test("shows the live panel only when PCO reports a service running", () => {
  assert.equal(homeMode(null), "idle");
  assert.equal(homeMode({ mode: "none" } as PcoLiveDTO), "idle");
  assert.equal(homeMode({ mode: "item" } as PcoLiveDTO), "live");
  assert.equal(homeMode({ mode: "preservice" } as PcoLiveDTO), "live");
});
```

`mode: "none"` is the server saying the service ENDED; treating any payload as
live leaves Home in service mode all week — the same bug the context bar's guard
covers.

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement** `homeMode()` plus the two panels. Live: service timer, current and next item, recording status, SPL, outputs online. Idle: next service with countdown, this week's plan summary, readiness, and headline trends.
- [ ] **Step 4: Reuse History's derivations.** `inTrendScope`/`inAverageScope` in `overview-scope.ts` already scope records; Home imports them rather than recomputing. Duplicating the scoping is how two surfaces come to disagree about the same number.
- [ ] **Step 5: Drill-down.** Each summary links into History rather than restating it.
- [ ] **Step 6: Human check** — with a real service live if possible, otherwise state plainly that the live path is unit-tested only.
- [ ] **Step 7: Commit.**

---

## Task 3: Commissioning a screen

**Files:** Create `renderer/app/home/commission.tsx`; delete `renderer/main/display-picker-view.tsx`; modify `root-view.tsx`, `remote-server.ts`, `operator-paths.ts`

`/` currently answers "which display is this screen?". Home takes the URL, so
that job needs somewhere to live or a freshly-pointed monitor is stranded.

- [ ] **Step 1: Write the failing test** — every output is offered, and the icon tints survive:

```tsx
test("offers every configured output, with its chosen tint", () => {
  // iconColors are keyed by display id and set from Displays/Connect. Dropping
  // them silently discards a colour an operator picked.
  const items = commissionTargets(state);
  assert.equal(items.length, state.outputs.length);
  assert.equal(items.find((i) => i.id === "d1")?.color, "#e0653a");
});

test("falls back to the theme accent for an untinted output", () => {
  assert.equal(commissionTargets(untinted)[0].color, "var(--su-accent)");
});
```

- [ ] **Step 2: Run, fail, implement, pass.**
- [ ] **Step 3: Route `/` to the operator app** in `operator-paths.ts` and `remote-server.ts`; `root-view.tsx` keeps only `/display-N`.
- [ ] **Step 4: Verify against the real server** — `/` serves the app chunk, `/display-1` still serves the kiosk with `kiosk` and forced dark, and the asset hash matches the local build.
- [ ] **Step 5: Human check** — commission a screen end to end, and confirm a wall display is unchanged.
- [ ] **Step 6: Commit.**

---

## Task 4: Screens — Outputs and Views on one surface

**Files:** Create `renderer/app/screens/screens-route.tsx`; modify `destinations.tsx`, `router.tsx`

A card per Output showing what it displays and whether it is online, with the
View library alongside. **Presentation only** — the Views/Outputs model is
correct and unchanged, and every handler comes across as-is.

- [ ] **Step 1: Write the failing test** — the join is the thing that was in the operator's head:

```tsx
test("pairs every output with the view it shows", () => {
  const rows = screenRows(state, ["d1"]);
  assert.equal(rows.find((r) => r.outputId === "d1")?.viewName, "Mic board");
  assert.equal(rows.find((r) => r.outputId === "d1")?.online, true);
});

test("an unassigned output says so rather than showing a blank", () => {
  // "no view" and "a view named nothing" must not look identical.
  assert.equal(screenRows(unassigned, [])[0].viewName, null);
});
```

- [ ] **Step 2: Run, fail, implement, pass.**
- [ ] **Step 3: Fold in presence** from the `displays:presence` channel.
- [ ] **Step 4: Retire the separate routes** — `/views` and `/displays` redirect to `/screens`, since both shipped as URLs in Phase 1b.
- [ ] **Step 5: Human check** — assign a View, confirm the wall display changes; reorder; confirm presence goes stale when a display disconnects.
- [ ] **Step 6: Commit.**

---

## Task 5: Redirects, verification and PR

- [ ] **Step 1:** `/plan` → `/`, `/views` and `/displays` → `/screens`, with a test asserting each resolves to a route that exists — the same shape as `legacy-hash.test.ts`.
- [ ] **Step 2:** `lint`, `type-check`, `test`, `build`; read all four.
- [ ] **Step 3:** Walk the parity inventory in a browser at desktop **and** phone widths.
- [ ] **Step 4:** Confirm the kiosk chunk still differs from the app chunk, and `/display-N` is untouched.
- [ ] **Step 5:** Kill test servers by port; confirm the served hash matches the build.
- [ ] **Step 6:** Open the PR; report the checks that actually ran.

---

## Out of scope for Phase 2

- **`View.surface`, Output modes, control objects, drill-down objects** — Phase 3.
- **Home as an editable console** — Phase 4, once edit mode exists. Home ships as a fixed arrangement of the same widgets, so nothing built here is discarded.
- **The configurable context-bar registry** — Phase 3.
- **Route-level code splitting** — worth doing once the layout editor and history charts are in the bundle, with measurements.
