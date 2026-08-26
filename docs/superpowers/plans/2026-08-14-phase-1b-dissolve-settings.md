# Phase 1b — Dissolving Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the remaining twelve settings sections onto routes in the operator app, retire `settings-window.html`, and shrink Settings to the four surfaces that are genuinely configuration.

**Architecture:** `settings-view.tsx` (1,402 lines) holds 8 React Query calls, 43 handlers and 9 pieces of local state, and threads them into sections as props. **No context provider is introduced.** Those 8 queries are already React Query, which is itself the shared cache — a route calling `useQuery` with the same key gets the same data, deduped. So the extraction is two plain modules (shared query hooks, shared handlers) that any route imports, and `settings-view.tsx` dissolves rather than being replaced by an equally large provider.

**Tech Stack:** React 19, TypeScript, `@tanstack/react-router`, `@tanstack/react-query` ^5.101.4, Tailwind v4, `node --test` with `tsx`, jsdom via `renderer/test-dom.ts`.

**Depends on:** Phase 1a (PR #257). Branch from `feat/operator-shell` if that has not merged, and rebase onto `beta` once it has.

## Global Constraints

- **No emojis anywhere** — source, UI copy, comments, commit messages, PR bodies.
- **No direct pushes.** Branch, open a PR, let the maintainer merge.
- **Every `catch` rethrows or returns the failure to its caller.** A `catch` that only logs is prohibited.
- **A guard must fail on the bug it guards** — reintroduce the bug, watch it go red, say so in the commit.
- **Prod is not a secure context.** No `crypto.randomUUID`, `crypto.subtle`, clipboard write or service workers without a fallback.
- **Fixing a repeated pattern:** grep every instance, fix together, state the counts in the commit.
- **Dark surfaces are strictly R=G=B neutral.**
- **Tests run with** `npm test` (`node --import tsx --test`). No vitest, no jest.
- **DOM tests call `installDom()` at module top level, then `await import(...)`** the component.
- **Verify before claiming.** Run `lint`, `type-check`, `test`, `build`, and drive the real server.

---

## Feature parity inventory

Built by **reading all 1,402 lines** of `settings-view.tsx`, not by grepping it.
The first draft of this inventory was grep-derived and missed twelve behaviours,
including one — the query keys — that would have broken live updates silently.

**No row may be dropped without a stated reason or a named replacement**, and a
row marked carried must be **checked in a browser at desktop and phone widths**.
Phase 1a marked the mobile drawer carried without ever resizing the window.

### Data layer

| Feature | Detail | Disposition |
|---|---|---|
| 8 shared queries | Keys are `["stage:getState"]`, `["stage:listServiceTypes"]`, `["stage:listPlans", serviceTypeId]`, `["stage:listTeamPositions", serviceTypeId]`, `["wireless:listChannels"]`, `["layoutTemplates:list"]`, `["presets:list"]`, `["update:status"]` | **Carried with the keys UNCHANGED.** Not a stylistic choice: all 43 handlers and three SSE listeners write into these exact keys with `setQueryData`. Renaming them silently detaches live updates from the UI. |
| `enabled` gates | serviceTypes gated on `pcoConfigured`; plans on `serviceTypeId`; teamPositions on both | **Carried verbatim.** The PCO gate exists because ungated retries filled the server log with "PCO not configured" on unconfigured machines. |
| `stage:state-changed` → cache | `queryClient.setQueryData(["stage:getState"], s)` | **Carried.** This is how every surface sees a change made anywhere. |
| `slots:devices` → cache merge | `applyDeviceTelemetry(prev, payload)` on its own channel | **Carried.** Separate channel so a meter twitch does not re-send the whole state document; keeps the slot editor's RF bars live. |
| `update:status` → cache + completion | Durable completion signal; clears the pending flag on error instead of reloading | **Carried.** The slower but reliable partner to `server:hello`. |
| `integrations:state-changed` | On PCO connect, invalidates serviceTypes / getState / listPlans | **Carried.** Without it, connecting PCO leaves the plan list stale. |
| `applyAccentVar(stageState.accentColor)` | Runtime injection of the themeable brand accent | **Carried.** Losing it means a church's chosen accent silently stops applying. |

### Update lifecycle

| Feature | Detail | Disposition |
|---|---|---|
| `UPDATE_PENDING_KEY` / `UPDATE_DONE_KEY` | sessionStorage handshake spanning the restart | **Carried.** sessionStorage, not local, so it is scoped to the tab. |
| `server:hello` version-change detection | Fast path: a new version means the new build is live | **Carried.** |
| `reloadScheduledRef` one-shot guard | Stops the two completion signals double-reloading | **Carried.** |
| 900ms beat before reload | Lets the "restarting" step paint first | **Carried.** |
| `justUpdated` success banner | Read once from sessionStorage on mount | **Carried**, with Advanced. |

### Navigation and chrome

| Feature | Detail | Disposition |
|---|---|---|
| Hash deep links | `#integrations` read on mount, mirrored with `replaceState`, plus a `hashchange` listener | **Replaced by routes, with redirects.** `replaceState` was deliberate — tab switches stayed out of the history stack. Routes push by design, which is the point; the redirect uses `replace: true` so old links do not add an entry. |
| Default landing tab | Views, deliberately not Plan (Plan assumes PCO) | **Carried.** `/settings` redirects to the first configuration surface; the app's own landing stays the rail. |
| Nav group labels | `NAV_GROUPS` — Content / Screens / Devices / Services / System | **Carried.** Deferred in 1a at six destinations; earned at ~12. |
| Per-section title + description | `SECTION_DESC` | **Carried** onto `Destination.description`. |
| `navigateToSection(id, flash?)` | Two rAFs, `scrollIntoView({behavior:"smooth", block:"center"})`, `void el.offsetWidth` to restart a running animation, class removed after 2s | **Carried in full.** The reflow read and the scroll are both load-bearing and were missing from the first draft of this plan. |
| Getting Started onboarding | Gated on `onboardingDismissed`; `onNavigate` drives the above | **Carried**, with Plan. |
| `historyNonce` | History remounts to its landing list when re-selected | **Carried.** **AUDIT 2026-08-14: shipped un-wired; fixed.** See Phase 1a. |
| `withViewTransition` | Crossfade on section change | **Carried where free**, feature-detected. **AUDIT 2026-08-14: shipped un-wired; fixed.** See Phase 1a. |
| Per-section `ErrorBoundary` | Keyed by section id | **Carried** as per-route `errorComponent` (already done in 1a). |
| `SECTION_PAGE` links | External links to the standalone pages | **Replaced** by in-app links; those are rail destinations now. |
| Escape-to-close | `invoke("window:closeSettings")` | **Dropped, with reason.** It closed the settings *window*. Once Settings is routes there is nothing to close to, and the IPC channel has no meaning from inside the app. |

### Editors

| Feature | Detail | Disposition |
|---|---|---|
| DnD sensors | `MouseSensor` (distance 5) + `TouchSensor` (delay 200, tolerance 8), deliberately separate | **Carried verbatim.** A single `PointerSensor` claimed the gesture on touch-down and made the Displays and Views lists unscrollable on a phone. This is a hard-won fix; do not "simplify" it. |
| `handleDragEnd` stacked-group reorder | Reorders by lead slot so a stacked column moves as one and never splits | **Carried verbatim.** |
| Slot editor state | `localSlots`, `slotsDirty`, `isSavingSlots`, `selectedViewId`, `isRefreshing` | **Carried.** Local to the Views surface, so it moves with it rather than into a shared module. |
| Debounced draft resolution | 250ms debounce → `views:resolveSlots`, feeding the live preview | **Carried.** Without the debounce this is a request per keystroke. |
| `resolvedDraftSlots` | Cleared when the editor goes clean | **Carried.** |

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `renderer/app/queries.ts` | The 8 shared query hooks, one query key each. |
| `renderer/app/queries.test.ts` | Query keys are unique and stable. |
| `renderer/app/handlers.ts` | `useStageHandlers(): SectionHandlers`. |
| `renderer/app/flash.ts` | `flashTarget(id)` — the post-navigation highlight. |
| `renderer/app/flash.test.ts` | Flash applies, clears, and tolerates a missing target. |
| `renderer/app/settings-routes.tsx` | The four configuration destinations. |
| `renderer/app/redirects.test.ts` | Every legacy hash link resolves to a route. |

**Modified**

| File | Change |
|---|---|
| `renderer/app/destinations.tsx` | Gains Plan, Views, Displays; groups; settings children. |
| `renderer/app/router.tsx` | `/settings` and `/settings/*` routes; hash redirect. |
| `renderer/app/rail.tsx` | Renders `SidebarGroupLabel` groups; Settings joins the list. |
| `main/services/routes/operator-paths.ts` | Adds the new operator paths. |
| `main/services/remote-server.ts` | `/settings` resolves to `app.html`. |
| `vite.config.ts` | Drops the `settings` rollup input. |

**Deleted**

| File | Why |
|---|---|
| `settings-window.html` | The operator app serves `/settings` now. |
| `renderer/settings/index.tsx` | Its React root is the operator app's. |
| `renderer/settings/settings-view.tsx` | Dissolved into queries, handlers and routes. |

---

## Task 1: Shared query hooks

**Files:** Create `renderer/app/queries.ts`, `renderer/app/queries.test.ts`

**Interfaces:**
- Produces: `useStageStateQuery()`, `useServiceTypes()`, `usePlans(serviceTypeId)`, `useTeamPositions()`, `useWirelessChannels()`, `useLayoutTemplates()`, `useSlotPresets()`, `useUpdateStatus()`, and `QUERY_KEYS`.

**No provider.** React Query is already the shared cache: two routes calling the
same key share one fetch and one cache entry. A context provider would add a
second state layer over it and re-render every consumer on any change.

- [ ] **Step 1: Write the failing test**

```ts
// renderer/app/queries.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { QUERY_KEYS } from "./queries.js";

describe("shared query keys", () => {
  test("every key is unique", () => {
    // Two hooks sharing a key silently serve each other's data - the wrong
    // shape arrives where the types say it cannot.
    const keys = Object.values(QUERY_KEYS).map((k) => JSON.stringify(typeof k === "function" ? k("x") : k));
    assert.equal(new Set(keys).size, keys.length, "duplicate query key");
  });

  test("keys are arrays, so React Query can match them partially", () => {
    for (const [name, k] of Object.entries(QUERY_KEYS)) {
      const resolved = typeof k === "function" ? k("x") : k;
      assert.ok(Array.isArray(resolved), `${name} must be an array key`);
    }
  });

  test("the plans key varies by service type", () => {
    // A single "plans" key would serve one service type's plans for another,
    // which reads as the wrong week's data rather than as an error.
    assert.notDeepEqual(QUERY_KEYS.plans("a"), QUERY_KEYS.plans("b"));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="shared query keys"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Copy each `useQuery` call out of `settings-view.tsx` **verbatim** — same
`queryKey`, `queryFn`, and `enabled`. The keys in particular are load-bearing:
43 handlers and three SSE listeners write into them with `setQueryData`, so a
rename detaches live updates from the UI with nothing failing loudly.

```ts
// renderer/app/queries.ts
// The queries every operator surface shares.
//
// Extracted from settings-view.tsx unchanged. No context provider: React Query
// is already the shared cache, so two routes calling the same key share one
// fetch. A provider would add a second state layer on top and re-render every
// consumer whenever any part of it changed.
//
// THE KEYS ARE THE OLD KEYS, deliberately. Every handler writes results back
// with setQueryData against these exact arrays, and three SSE listeners push
// into them. A tidier scheme would have silently unhooked live updates.

import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/api";

function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>(channel, args[0] as Record<string, unknown> | undefined);
}

export const QUERY_KEYS = {
  stageState: ["stage:getState"] as const,
  serviceTypes: ["stage:listServiceTypes"] as const,
  plans: (serviceTypeId?: string) => ["stage:listPlans", serviceTypeId] as const,
  teamPositions: (serviceTypeId?: string) => ["stage:listTeamPositions", serviceTypeId] as const,
  wirelessChannels: ["wireless:listChannels"] as const,
  layoutTemplates: ["layoutTemplates:list"] as const,
  slotPresets: ["presets:list"] as const,
  updateStatus: ["update:status"] as const,
};

export function useStageStateQuery() {
  return useQuery({ queryKey: QUERY_KEYS.stageState, queryFn: () => ipc<StageState>("stage:getState") });
}

export function useServiceTypes(stageState: StageState | undefined) {
  // Gated on PCO being configured. Ungated, this retried on every load and
  // filled the server log with "PCO not configured" on a machine that simply
  // had not been set up yet.
  return useQuery({
    queryKey: QUERY_KEYS.serviceTypes,
    queryFn: () => ipc<ServiceTypeDTO[]>("stage:listServiceTypes"),
    enabled: !!stageState?.pcoConfigured,
  });
}
```

The remaining five follow the same shape, each keeping its original `enabled`
gate. Add a test asserting the keys match the strings the handlers use:

```ts
test("the keys are the ones handlers and SSE listeners write to", () => {
  // Not cosmetic. setQueryData(["stage:getState"], next) appears in 43
  // handlers; if this key changes, every write lands in a cache entry nothing
  // reads and the UI stops updating without a single error.
  assert.deepEqual(QUERY_KEYS.stageState, ["stage:getState"]);
  assert.deepEqual(QUERY_KEYS.updateStatus, ["update:status"]);
  assert.deepEqual(QUERY_KEYS.plans("st1"), ["stage:listPlans", "st1"]);
});
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- --test-name-pattern="shared query keys"` → PASS, 3 tests.

- [ ] **Step 5: Prove the uniqueness guard**

Point two keys at the same array. The uniqueness test must go RED. Restore.

- [ ] **Step 6: Commit**

```bash
git add renderer/app/queries.ts renderer/app/queries.test.ts
git commit -m "feat(shell): shared query hooks, extracted verbatim

No context provider - React Query is already the shared cache, so two routes
on the same key share one fetch. Keys were copied unchanged so a regression
cannot be blamed on a rewritten fetch.

Uniqueness guard proved: pointing two hooks at one key turns it red."
```

---

## Task 2: Shared handlers

**Files:** Create `renderer/app/handlers.ts`; modify `renderer/settings/settings-view.tsx`

**Interfaces:**
- Consumes: `renderer/app/queries.ts`.
- Produces: `useStageHandlers(): SectionHandlers` — the **same** `SectionHandlers` contract from `renderer/settings/types.ts`, so no section's props change.

Keeping the existing contract is what makes this safe: sections are moved without
being edited, so a broken section is a routing bug, not a rewritten handler.

- [ ] **Step 1: Move the 43 handlers verbatim**

Cut each `handle*` function from `settings-view.tsx` into `useStageHandlers()`.
Do not rename, re-order or "tidy" any of them. Return the same object literal
that `settings-view.tsx` builds today.

- [ ] **Step 2: Point settings-view at it**

`settings-view.tsx` calls `const handlers = useStageHandlers();` and passes it on
exactly as before. It should shrink by roughly 500 lines with no behaviour change.

- [ ] **Step 3: Verify nothing changed**

```bash
npm run type-check && npm run lint && npm test
```
All must pass. Then drive the settings panel in a browser and exercise one
handler per group: change the service type, rename a View, toggle a display,
save branding, check for updates.

**Human check required.** These are the writes an operator makes; a silent
failure here is the "reported success having written nothing" case.

- [ ] **Step 4: Commit**

```bash
git add renderer/app/handlers.ts renderer/settings/settings-view.tsx
git commit -m "refactor(shell): extract the 43 settings handlers unchanged

Same SectionHandlers contract, so no section's props change and a moved
section that breaks is a routing bug rather than a rewritten handler.

Verified against a running server: service type, view rename, display
assignment, branding save and update check all still write."
```

---

## Task 3: Settings sections become routes

**Files:** Modify `renderer/app/destinations.tsx`, `renderer/app/router.tsx`, `renderer/app/rail.tsx`, `main/services/routes/operator-paths.ts`, `main/services/remote-server.ts`; create `renderer/app/settings-routes.tsx`

**Interfaces:**
- Produces: `/plan`, `/views`, `/displays` as rail destinations; `/settings`, `/settings/integrations`, `/settings/connect`, `/settings/branding`, `/settings/advanced`.

Views and Displays stay separate here. Merging them into one Screens surface is
Phase 2 — doing both at once would mean a routing change and a redesign in the
same diff.

- [ ] **Step 1: Extend the operator path table**

Add `/plan`, `/views`, `/displays`, `/settings` to `OPERATOR_PATHS`. The
reserved-slug list derives from it, so those become reserved automatically —
that derivation exists because `/automation` and `/integrations` were routed
without being reserved in Phase 1a.

- [ ] **Step 2: Restore the nav groups**

The rail now carries about twelve destinations, which is where grouping earns
its place. Use `SidebarGroupLabel` — the component settings already used, which
degrades to a divider in the collapsed rail:

```tsx
const NAV_GROUPS: { label: string; paths: string[] }[] = [
  { label: "Content", paths: ["/plan", "/views", "/scriptview", "/patch"] },
  { label: "Screens", paths: ["/displays"] },
  { label: "Devices", paths: ["/integrations", "/automation"] },
  { label: "Services", paths: ["/history", "/baptism"] },
];
```

- [ ] **Step 3: Prove the grouping covers every destination**

```ts
test("every destination appears in exactly one nav group", () => {
  // A destination in no group renders outside the list; a destination in two
  // renders twice. Both are silent - the rail simply looks wrong.
  const grouped = NAV_GROUPS.flatMap((g) => g.paths);
  const settings = SETTINGS_DESTINATIONS.map((d) => d.path);
  for (const d of DESTINATIONS) {
    const count = grouped.filter((p) => p === d.path).length + settings.filter((p) => p === d.path).length;
    assert.equal(count, 1, `${d.path} appears in ${count} groups`);
  }
});
```

Prove it by removing one path from a group and watching it go red.

- [ ] **Step 4: Verify against the real server**

Every new path must serve the app chunk, and `/display-N` must still serve the
kiosk. Check the asset hash matches the local build first — a stale server is
how Phase 1a nearly verified nothing.

- [ ] **Step 5: Commit**

---

## Task 4: Cross-surface navigation and the flash highlight

**Files:** Create `renderer/app/flash.ts`, `renderer/app/flash.test.ts`; modify `renderer/settings/getting-started.tsx`

**Interfaces:**
- Produces: `flashTarget(flashId: string): void`.

`navigateToSection(id, flash?)` did two things: switch tab, then find
`[data-flash-id="…"]` and pulse it. Getting Started uses it to point at a
specific field. Under routing the switch is a navigation, and the flash must run
**after the destination route has rendered** — the element does not exist at
navigation time.

- [ ] **Step 1: Write the failing test**

```ts
// renderer/app/flash.test.ts
import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";
import { installDom } from "../test-dom.js";

const teardown = installDom();
const { flashTarget, FLASH_CLASS } = await import("./flash.js");

after(() => teardown());

describe("flash highlight", () => {
  test("applies the class to the matching target", async () => {
    const el = document.createElement("div");
    el.setAttribute("data-flash-id", "pco-token");
    document.body.appendChild(el);
    flashTarget("pco-token");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(el.classList.contains(FLASH_CLASS));
    el.remove();
  });

  test("does not throw when the target never appears", async () => {
    // The destination may not render the field at all - an integration that is
    // not configured, say. A throw here would blank the whole route.
    await assert.doesNotReject(async () => {
      flashTarget("nothing-with-this-id");
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  test("re-flashing the same target restarts the animation", async () => {
    // Removing and re-adding the class in one frame is a no-op; the class must
    // be dropped, a frame allowed to pass, then re-added, or a second click
    // does nothing visible.
    const el = document.createElement("div");
    el.setAttribute("data-flash-id", "twice");
    document.body.appendChild(el);
    flashTarget("twice");
    await new Promise((r) => setTimeout(r, 50));
    flashTarget("twice");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(el.classList.contains(FLASH_CLASS));
    el.remove();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Port the existing polling logic from `settings-view.tsx` (it already waits for
the element to render and removes the class after 2s). Keep the same
`data-flash-id` attribute and `su-flash` class so no section markup changes.

- [ ] **Step 4: Wire Getting Started**

`onNavigate` becomes `(path, flash) => { router.navigate({ to: path }); flashTarget(flash); }`.

- [ ] **Step 5: Prove the missing-target guard**

Make `flashTarget` assume the element exists (`el.classList.add` with no null
check). The "does not throw" test must go RED. Restore.

- [ ] **Step 6: Human check**

Open Getting Started, click each of its links, and confirm the destination
renders **and** the field pulses. This cannot be asserted from a test: the test
proves the mechanism, not that the ids in Getting Started still match anything.

- [ ] **Step 7: Commit**

---

## Task 5: Retire the settings document

**Files:** Delete `settings-window.html`, `renderer/settings/index.tsx`, `renderer/settings/settings-view.tsx`; modify `vite.config.ts`, `main/services/remote-server.ts`; create `renderer/app/redirects.test.ts`

- [ ] **Step 1: Write the redirect test first**

```ts
// renderer/app/redirects.test.ts
// /settings#integrations was a deep link into the old tabbed panel. Those are
// in bookmarks and in the Connect tab's copy-to-clipboard links; dropping them
// is a 404 for someone who did what the app told them to.
describe("legacy settings hash links", () => {
  test("every old section hash maps to a route", () => {
    const LEGACY = ["plan","views","scriptview","displays","integrations","connect",
                    "branding","service-history","baptisms","patch","automation","advanced"];
    for (const h of LEGACY) {
      const target = legacyHashRoute(h);
      assert.ok(target, `#${h} has no route`);
      assert.ok(target.startsWith("/"), `#${h} maps to "${target}", not a path`);
    }
  });
});
```

- [ ] **Step 2: Implement the redirect** in the `/settings` route: read
`location.hash`, map it, and `router.navigate` with `replace: true` so the back
button does not bounce.

- [ ] **Step 3: Delete the entry point** and drop `settings` from
`vite.config.ts`'s `rollupOptions.input`. `remote-server.ts` resolves `/settings`
through `isOperatorPath` instead of its own branch.

- [ ] **Step 4: Verify the build has two documents, not three**

```bash
npm run build && ls build/renderer/*.html
```
Expected: `index.html` and `app.html`. `settings-window.html` must be gone.

- [ ] **Step 5: Verify every legacy URL still lands**

Drive the real server: `/settings`, `/settings/`, and each `#hash` must render
the right surface, and `/display-N` must still serve the kiosk.

- [ ] **Step 6: Commit**

---

## Task 6: Whole-branch verification and PR

- [ ] **Step 1:** `npm run lint && npm run type-check && npm test && npm run build` — read all four.
- [ ] **Step 2:** Confirm two entry documents and that the kiosk chunk still differs from the app chunk.
- [ ] **Step 3: Walk the parity inventory in a browser**, at desktop **and** at a phone viewport. Phase 1a's mobile drawer was marked carried without ever resizing the window.
- [ ] **Step 4:** Kill test servers by port. Confirm the served asset hash matches the local build before trusting any URL check.
- [ ] **Step 5:** Open the PR; report the checks that actually ran.

---

## Out of scope for Phase 1b

- **Home at `/`** — Phase 2. `/` stays the display picker.
- **Views and Outputs merging into Screens** — Phase 2. They arrive here as separate routes.
- **Plan folding into Home** — Phase 2. `/plan` is a rail destination in the interim.
- **The configurable context-bar registry** — Phase 3.
- **Route-level code splitting** — worth doing once the layout editor and history charts join the bundle, but it is a separate change with its own measurements.
