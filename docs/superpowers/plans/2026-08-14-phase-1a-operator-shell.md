# Phase 1a — Operator Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third entry point — an operator app with browser-history routing, a persistent navigation rail and a live context bar — that serves `/patch`, `/history`, `/baptism`, `/scriptview`, `/automation` and `/integrations`, leaving the existing settings panel and kiosk untouched.

**Architecture:** A new `app.html` entry mounts `renderer/app/`, a TanStack Router tree using browser history. The shell is rail + context bar + `<Outlet/>`. Six settings sections already take no props and are rendered directly by routes; the History and Baptisms standalone wrappers are dropped in favour of those routes. The kiosk (`index.html`) keeps `/` and `/display-*`; the settings panel (`settings-window.html`) keeps `/settings`. Nothing is removed, so a fault is escaped by not using the new URLs.

**Tech Stack:** React 19, TypeScript, `@tanstack/react-router` ^1.170.27, `@tanstack/react-query` ^5.101.4, Tailwind v4 (CSS-configured), Vite (rolldown), `node --test` with `tsx`, jsdom via `renderer/test-dom.ts`.

## Global Constraints

- **No emojis anywhere** — source, UI copy, comments, commit messages, PR bodies.
- **No direct pushes.** Branch off `beta`, open a PR, let the maintainer merge. Never merge it yourself.
- **Every `catch` rethrows or returns the failure to its caller.** A `catch` that only logs is prohibited.
- **A guard must fail on the bug it guards** — reintroduce the bug, watch the test go red, and say so in the commit.
- **Prod is not a secure context.** Never call `crypto.randomUUID`, `crypto.subtle`, clipboard write or service-worker APIs without a fallback.
- **Fixing a repeated pattern:** grep for every instance and fix them together; state in the commit how many were found and how many changed.
- **Numeric fields use the themed `NumberInput`**, never a raw `<input type="number">`.
- **Dark surfaces are strictly R=G=B neutral.** No blue-biased darks, no `saturate()` over dark.
- **Tests run with** `npm test` (which is `node --import tsx --test` over `main/**/*.test.ts`, `renderer/**/*.test.ts`, `renderer/**/*.test.tsx`, `scripts/**/*.test.ts`). There is no vitest and no jest.
- **DOM tests must call `installDom()` at module top level and then `await import(...)` the component** — a `before` hook runs after the module body, so a static import renders into nothing.
- **Verify before claiming.** Run `npm run lint`, `npm run type-check`, `npm test` and `npm run build`, and read the output in-session.

---

## Feature parity inventory

The settings shell carries chrome that has nothing to do with settings — it is
*shell* behaviour, and the operator app needs it too. **Nothing in this table may
be dropped without an explicit decision recorded here.** A migration that quietly
loses a control is a regression the operator discovers on a Sunday.

| Feature | Where it lives now | Disposition in 1a |
|---|---|---|
| Theme toggle — light / **system** / dark, three-way | `ThemeTogglePill` + `useTheme` in `settings-view.tsx` | **Carried.** Extracted to a shared module so both shells use one copy. |
| Theme persistence (`stage-utility-theme`) with pre-paint application | `settings-view.tsx` + `settings-window.html` inline script | **Carried.** `app.html` carries the same inline bootstrap. |
| Version + branch readout | rail footer, from `updateStatus` | **Carried.** |
| Build-identity tooltip (version, track, commit, date) | `buildLabel(updateStatus)` | **Carried.** It is what gets asked for when something needs diagnosing. |
| Sidebar collapse, persisted (`SIDEBAR_COLLAPSED_KEY`) | `useSidebarCollapsed` | **Carried.** Extracted with the theme hook. |
| Rail-aware collapsed layout (vertical toggle, logo only) | `settings-view.tsx` render | **Carried.** |
| Mobile drawer with a title bar | `SplitView` + `useIsMobile` | **Carried.** `/patch` on a volunteer's phone makes this mandatory, not optional. |
| Per-section header: title + description | `SECTION_DESC` | **Carried.** Each destination declares its own. |
| `ErrorBoundary` **per section** | keyed by `activeSection.id` | **Carried, per route.** A render error in History must not blank the shell. |
| Re-selecting History resets it to its top view | `historyNonce` | **Carried.** Clicking the active rail item resets that route. **AUDIT 2026-08-14: shipped un-wired; fixed.** The rail navigated to the path it was already on — a no-op, so nothing reset. Now `renderer/app/route-reset.ts`, keyed on the shell's Outlet. |
| Nav group labels (Content / Screens / …) | `NAV_GROUPS` | **Deliberately not carried in 1a.** Six destinations do not need grouping; groups return in 1b when the rail reaches ~10 items. |
| Escape-to-close | `useEscapeToClose` | **Deliberately not carried.** It closes the settings *window*. The operator app is the app, not a modal over it — there is nothing to close to. |
| View transitions on section change | `withViewTransition` | **Carried where free.** Guarded: `document.startViewTransition` is not universal, so it must be feature-detected. **AUDIT 2026-08-14: shipped un-wired; fixed.** The helper existed and nothing imported it. Now called by the rail on navigation. |
| Update-completion detection and reload | `justUpdated` + `server:hello` | **Stays in settings for 1a.** It belongs with Advanced, which does not move until 1b. |

Two of these are marked "deliberately not carried" and both have a stated reason.
Everything else is carried. Task 4 implements them and its test asserts the set.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `app.html` | Operator-app entry document. Theme bootstrap before paint (copied from `settings-window.html`, NOT the kiosk's forced dark). |
| `renderer/app/index.tsx` | React root: providers + `RouterProvider`. |
| `renderer/app/router.tsx` | Route tree and router instance. Browser history. |
| `renderer/app/shell.tsx` | Rail + context bar + `<Outlet/>` layout. |
| `renderer/app/rail.tsx` | Navigation rail: brand header, destinations, footer. |
| `renderer/app/destinations.tsx` | The single list of rail destinations. One source of truth for the router and the rail. |
| `renderer/app/context-bar.tsx` | Live service context strip. |
| `renderer/app/routes.test.tsx` | Route-tree and rail-parity tests. |
| `renderer/app/context-bar.test.tsx` | Context-bar behaviour tests. |
| `renderer/lib/use-theme.ts` | Theme mode + persistence, extracted from `settings-view.tsx` so both shells share one copy. |
| `renderer/lib/use-sidebar-collapsed.ts` | Persisted rail collapse, extracted likewise. |
| `renderer/components/ui/theme-toggle-pill.tsx` | The three-way light/system/dark pill, including its `vertical` variant. |
| `renderer/components/ui/build-label.tsx` | `buildLabel()` — version, track, commit and date for the footer tooltip. |
| `renderer/app/chrome-parity.test.tsx` | Asserts the parity inventory's carried rows. |
| `main/services/routes/operator-paths.ts` | `OPERATOR_PATHS` + `isOperatorPath()`, shared by the server and the Vite dev plugin. |
| `main/services/routes/operator-paths.test.ts` | Path-matching tests. |

**Modified**

| File | Change |
|---|---|
| `vite.config.ts` | Add `app` to `rollupOptions.input`; extend `cleanUrls()` to map operator paths to `app.html`. |
| `main/services/remote-server.ts` | `tryServeStatic` maps operator paths to `app.html`. |
| `renderer/main/root-view.tsx` | Drop `/history`, `/patch`, `/baptism`, `/scriptview` branches; kiosk keeps `/` and `/display-*`. |
| `renderer/settings/settings-view.tsx` | `SECTION_PAGE` entries point at the shell routes; local `useTheme`, `useSidebarCollapsed`, `ThemeTogglePill` and `buildLabel` replaced by imports of the extracted copies. |
| `docs/display-urls.md` | Document the operator URLs. |

**Deleted**

| File | Why |
|---|---|
| `renderer/main/history-view.tsx` | 38-line wrapper around `ServiceHistorySection`, which the `/history` route now renders directly. |
| `renderer/main/baptism-operator-view.tsx` | 35-line wrapper around `BaptismOperator`, which the `/baptism` route now renders directly. |

`patch-view.tsx` and `scriptview-index-view.tsx` are **kept** — they are distinct surfaces, not duplicates, and the shell routes render them.

---

## Task 1: Operator path table

**Files:**
- Create: `main/services/routes/operator-paths.ts`
- Test: `main/services/routes/operator-paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `OPERATOR_PATHS: readonly string[]`, `isOperatorPath(pathname: string): boolean`.

Routing is implemented twice in this repo — a Vite plugin for dev and `remote-server.ts` for prod — and they have drifted before. Both import this module so they cannot disagree.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/routes/operator-paths.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPERATOR_PATHS, isOperatorPath } from "./operator-paths.js";

describe("operator paths", () => {
  it("claims every operator surface, with and without a trailing slash", () => {
    for (const p of OPERATOR_PATHS) {
      assert.ok(isOperatorPath(p), `${p} must be an operator path`);
      assert.ok(isOperatorPath(`${p}/`), `${p}/ must be an operator path`);
    }
  });

  it("claims nested operator routes", () => {
    assert.ok(isOperatorPath("/scriptview/sunday/full"));
    assert.ok(isOperatorPath("/patch/rack-a"));
  });

  it("leaves the kiosk and settings alone", () => {
    // These belong to index.html and settings-window.html. Claiming one would
    // black out a wall display or the control surface.
    for (const p of ["/", "/display-1", "/display-lobby", "/settings", "/settings/"]) {
      assert.equal(isOperatorPath(p), false, `${p} must NOT be an operator path`);
    }
  });

  it("does not claim a path that merely starts with an operator path's name", () => {
    // "/historyfoo" shares a prefix with "/history" but is not it. A naive
    // startsWith would swallow it and serve the wrong document.
    assert.equal(isOperatorPath("/historyfoo"), false);
    assert.equal(isOperatorPath("/patchwork"), false);
  });

  it("does not claim asset requests", () => {
    assert.equal(isOperatorPath("/assets/index-abc123.js"), false);
    assert.equal(isOperatorPath("/app-icon.png"), false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="operator paths"`
Expected: FAIL — `Cannot find module './operator-paths.js'`.

- [ ] **Step 3: Implement**

```ts
// main/services/routes/operator-paths.ts
// Which URLs belong to the operator app (app.html) rather than the kiosk
// (index.html) or the settings panel (settings-window.html).
//
// Routing is implemented twice — the `cleanUrls` Vite plugin for dev and
// `remote-server.ts` for prod — and the two have drifted before. Both import
// this, so a new operator route is added in exactly one place.

/** Top-level operator surfaces. Nested paths under each are also claimed. */
export const OPERATOR_PATHS = [
  "/history",
  "/baptism",
  "/patch",
  "/scriptview",
  "/automation",
  "/integrations",
] as const;

/**
 * Does this pathname belong to the operator app?
 *
 * Matches the exact path, a trailing slash, or a nested route beneath it.
 * Deliberately NOT `startsWith(p)`: that would claim "/historyfoo" and serve it
 * the wrong document. The boundary must be the end of the string or a "/".
 */
export function isOperatorPath(pathname: string): boolean {
  const clean = pathname.split("?")[0].split("#")[0];
  return OPERATOR_PATHS.some(
    (p) => clean === p || clean === `${p}/` || clean.startsWith(`${p}/`),
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- --test-name-pattern="operator paths"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the prefix guard fails on its bug**

Temporarily change `isOperatorPath` to `return OPERATOR_PATHS.some((p) => clean.startsWith(p));` and re-run. The "does not claim a path that merely starts with an operator path's name" test must go RED. Restore the real implementation and confirm green again.

- [ ] **Step 6: Commit**

```bash
git add main/services/routes/operator-paths.ts main/services/routes/operator-paths.test.ts
git commit -m "feat(routing): one table of which paths belong to the operator app

Dev and prod route independently and have drifted before, so both will
import this rather than each carrying a list.

The prefix guard was proved: relaxing isOperatorPath to a bare startsWith
turns the /historyfoo case red."
```

---

## Task 2: Serve the operator entry, in dev and prod

**Files:**
- Create: `app.html`
- Modify: `vite.config.ts`
- Modify: `main/services/remote-server.ts`

**Interfaces:**
- Consumes: `isOperatorPath` from Task 1.
- Produces: `app.html` served at every operator path in both dev and prod; `renderer/app/index.tsx` as its module entry.

- [ ] **Step 1: Create the entry document**

`app.html` — note the theme bootstrap is copied from `settings-window.html`, **not** the kiosk. The operator app follows the user's light/dark toggle; only wall displays are forced dark.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <link rel="icon" type="image/png" href="/app-icon.png" />
    <title>Stage Utility</title>
    <script>
      // Apply the saved theme before paint (no flash). Mirrors THEME_STORAGE_KEY
      // in settings-view.tsx. The operator app follows the toggle; the kiosk
      // (index.html) is deliberately always dark and does NOT share this.
      (function () {
        var saved = null;
        try { saved = localStorage.getItem("stage-utility-theme"); } catch (e) {}
        var dark =
          saved === "dark" || saved === "light"
            ? saved === "dark"
            : window.matchMedia("(prefers-color-scheme: dark)").matches;
        if (dark) document.documentElement.classList.add("dark");
      })();
    </script>
    <style>
      :root { --background: #f7f8fa; }
      .dark { --background: #0e0e0e; } /* pure neutral - R=G=B, no cool cast */
      html, body, #root { height: 100%; margin: 0; }
      body { background: var(--background); }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./renderer/app/index.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Add the entry to the build and the dev server**

In `vite.config.ts`, add the import and extend `cleanUrls()`:

```ts
import { isOperatorPath } from "./main/services/routes/operator-paths";
```

Replace the body of `cleanUrls`'s middleware with:

```ts
      server.middlewares.use((req, _res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (pathname === "/settings" || pathname === "/settings/") {
          req.url = "/settings-window.html";
        } else if (isOperatorPath(pathname)) {
          req.url = "/app.html";
        } else if (/^\/(display|preview)-[^/]+\/?$/.test(pathname)) {
          req.url = "/index.html";
        }
        next();
      });
```

And add `app` to the rollup input:

```ts
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings-window.html"),
        app: resolve(__dirname, "app.html"),
      },
```

- [ ] **Step 3: Route it in prod**

In `main/services/remote-server.ts`, import the helper next to the other service imports:

```ts
import { isOperatorPath } from "./routes/operator-paths.js";
```

and extend the entry-point mapping in `tryServeStatic`:

```ts
    let urlPath: string;
    if (pathname === "/" || pathname === "/index.html") {
      urlPath = "/index.html";
    } else if (pathname === "/settings" || pathname === "/settings/") {
      urlPath = "/settings-window.html";
    } else if (isOperatorPath(pathname)) {
      // The operator app. Checked before the generic fall-through so a nested
      // route like /scriptview/sunday/full reaches app.html rather than the
      // kiosk SPA fallback.
      urlPath = "/app.html";
    } else {
      urlPath = pathname;
    }
```

- [ ] **Step 4: Verify both paths serve the right document**

```bash
npm run build
node -e "
const fs=require('fs');
const out='build/renderer';
for (const f of ['index.html','settings-window.html','app.html']) {
  if (!fs.existsSync(out+'/'+f)) { console.error('MISSING', f); process.exit(1); }
}
console.log('all three entry documents built');
"
```
Expected: `all three entry documents built`.

Then start the server and check the real bytes, not just a 200:

```bash
npm run server &
until curl -sf http://localhost:8788/api/version > /dev/null; do sleep 1; done
for p in / /display-1 /settings /history /patch /scriptview/sunday/full /automation; do
  printf '%-28s %s\n' "$p" "$(curl -s http://localhost:8788$p | grep -o 'renderer/[a-z]*/index' | head -1)"
done
kill %1
```
Expected: `/` and `/display-1` show `renderer/main/index`; `/settings` shows `renderer/settings/index`; the four operator paths show `renderer/app/index`.

Note: `renderer/app/index.tsx` does not exist until Task 3, so this check is run again at the end of Task 3. For now confirm `app.html` is served (the grep is empty but the document differs from index.html).

- [ ] **Step 5: Commit**

```bash
git add app.html vite.config.ts main/services/remote-server.ts
git commit -m "feat(routing): serve the operator entry document in dev and prod

app.html carries the settings panel's pre-paint theme bootstrap, not the
kiosk's forced dark - the operator app follows the light/dark toggle.

Both routers go through isOperatorPath, so the dev plugin and remote-server
cannot drift."
```

---

## Task 3: Router, shell and rail

**Files:**
- Create: `renderer/app/destinations.tsx`, `renderer/app/router.tsx`, `renderer/app/shell.tsx`, `renderer/app/rail.tsx`, `renderer/app/index.tsx`
- Test: `renderer/app/routes.test.tsx`

**Interfaces:**
- Consumes: `OPERATOR_PATHS` from Task 1.
- Produces:
  - `DESTINATIONS: readonly Destination[]` where `Destination = { path: string; label: string; icon: ReactNode; Component: ComponentType }`
  - `router` (TanStack Router instance, browser history)
  - `<Shell/>`, `<Rail/>`

The rail and the route tree are both generated from `DESTINATIONS`, so a destination cannot exist in one and not the other.

- [ ] **Step 1: Write the failing test**

```tsx
// renderer/app/routes.test.tsx
import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { DESTINATIONS } = await import("./destinations.js");
const { OPERATOR_PATHS } = await import("../../main/services/routes/operator-paths.js");

after(() => {
  teardown();
});

describe("operator destinations", () => {
  test("every destination is a path the server routes to the operator app", () => {
    // A rail entry the server does not claim renders the kiosk instead: the
    // link looks right, and clicking it leaves the shell entirely.
    for (const d of DESTINATIONS) {
      const claimed = OPERATOR_PATHS.some((p) => d.path === p || d.path.startsWith(`${p}/`));
      assert.ok(claimed, `${d.path} is in the rail but the server does not route it`);
    }
  });

  test("every operator path the server claims has a destination", () => {
    // The reverse gap is a page that exists and is unreachable. Asserted as an
    // EXACT set rather than a count, so adding one on either side fails loudly.
    const railTops = new Set(DESTINATIONS.map((d) => `/${d.path.split("/")[1]}`));
    assert.deepEqual(
      [...railTops].sort(),
      [...OPERATOR_PATHS].sort(),
      "the rail and the server's operator paths must be the same set",
    );
  });

  test("paths and labels are unique", () => {
    assert.equal(new Set(DESTINATIONS.map((d) => d.path)).size, DESTINATIONS.length);
    assert.equal(new Set(DESTINATIONS.map((d) => d.label)).size, DESTINATIONS.length);
  });

  test("no destination label carries an emoji", () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const d of DESTINATIONS) {
      assert.equal(emoji.test(d.label), false, `${d.label} contains an emoji`);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="operator destinations"`
Expected: FAIL — `Cannot find module './destinations.js'`.

- [ ] **Step 3: Write the destination table**

```tsx
// renderer/app/destinations.tsx
// The rail's contents and the router's route tree, from one list.
//
// Two lists would let a destination exist in the rail with no route (a dead
// link) or a route with no rail entry (an unreachable page). routes.test.tsx
// asserts this set matches the server's OPERATOR_PATHS exactly.

import type { ComponentType, ReactNode } from "react";
import {
  CableIcon,
  ClockIcon,
  DropletIcon,
  ListChecksIcon,
  PlugIcon,
  ZapIcon,
} from "lucide-react";

import { PatchView } from "../main/patch-view";
import { ScriptViewIndex } from "../main/scriptview-index-view";
import { ScriptViewPlan } from "../main/scriptview-plan-view";
import { BaptismOperator } from "../main/baptism-operator";
import { ServiceHistorySection } from "../settings/sections/service-history-section";
import { AutomationSection } from "../settings/sections/automation-section";
import { IntegrationsSection } from "../settings/sections/integrations-section";

export interface Destination {
  /** Route path. Nested routes use the top-level segment for rail grouping. */
  path: string;
  label: string;
  icon: ReactNode;
  Component: ComponentType;
}

export const DESTINATIONS: readonly Destination[] = [
  {
    path: "/patch",
    label: "Patch",
    icon: <CableIcon className="size-4" />,
    // The volunteer-facing read view, NOT the settings editor. These are
    // different surfaces; the editor is reached from within this one.
    Component: PatchView,
  },
  {
    path: "/scriptview",
    label: "ScriptView",
    icon: <ListChecksIcon className="size-4" />,
    Component: ScriptViewIndex,
  },
  {
    path: "/history",
    label: "History",
    icon: <ClockIcon className="size-4" />,
    // The same component the settings tab renders. history-view.tsx was a
    // 38-line wrapper around it and is deleted in Task 5.
    Component: ServiceHistorySection,
  },
  {
    path: "/baptism",
    label: "Baptisms",
    icon: <DropletIcon className="size-4" />,
    Component: BaptismOperator,
  },
  {
    path: "/automation",
    label: "Automation",
    icon: <ZapIcon className="size-4" />,
    Component: AutomationSection,
  },
  {
    path: "/integrations",
    label: "Integrations",
    icon: <PlugIcon className="size-4" />,
    Component: IntegrationsSection,
  },
];

/** Nested routes that are reachable but not listed in the rail. */
export const NESTED_ROUTES: readonly { path: string; Component: ComponentType }[] = [
  { path: "/scriptview/$serviceType/$layout", Component: ScriptViewPlan },
];
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- --test-name-pattern="operator destinations"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove the parity guard fails on its bug**

Comment out the `/integrations` entry in `DESTINATIONS` and re-run. "every operator path the server claims has a destination" must go RED naming `/integrations`. Restore it and confirm green.

- [ ] **Step 6: Build the rail**

```tsx
// renderer/app/rail.tsx
// Persistent navigation. Brand header (identity - always shown, never
// configurable), destinations, then a footer for settings and theme.

import { Link, useRouterState } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { BrandLogo } from "../components/brand-logo";
import { useStageState } from "../main/use-stage-state";
import { DESTINATIONS } from "./destinations";
import { cn } from "../lib/cn";

export function Rail() {
  const { state } = useStageState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="flex flex-col w-56 shrink-0 border-r border-line bg-surface">
      <div className="flex items-center gap-2 h-12 px-3 shrink-0">
        {state?.appLogo && (
          <BrandLogo
            logo={state.appLogo}
            monochrome={state.appLogoMonochrome}
            className="size-5 rounded select-none"
          />
        )}
        <span className="text-caption1 font-title text-fg truncate select-none">
          {state?.appName ?? "Stage Utility"}
        </span>
      </div>

      <div className="flex flex-col gap-0.5 px-2 py-2 min-h-0 overflow-y-auto">
        {DESTINATIONS.map((d) => {
          const active = pathname === d.path || pathname.startsWith(`${d.path}/`);
          return (
            <Link
              key={d.path}
              to={d.path}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-body transition-colors",
                active ? "bg-fill text-fg" : "text-fg-muted hover:bg-fill-hover hover:text-fg",
              )}
            >
              {d.icon}
              <span className="truncate">{d.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="mt-auto px-2 py-2 border-t border-line">
        {/* Settings is still its own document in Phase 1a; it becomes routes in
            Phase 1b. A full navigation is correct here, not a router Link. */}
        <a
          href="/settings"
          className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-body text-fg-muted hover:bg-fill-hover hover:text-fg transition-colors"
        >
          <SettingsIcon className="size-4" />
          <span>Settings</span>
        </a>
      </div>
    </nav>
  );
}
```

- [ ] **Step 7: Build the shell**

```tsx
// renderer/app/shell.tsx
// Rail + context bar + content. The one layout every operator surface renders
// inside, which is what makes the app feel like one program rather than a set
// of pages that happen to share a server.

import { Outlet } from "@tanstack/react-router";
import { Rail } from "./rail";
import { ContextBar } from "./context-bar";

export function Shell() {
  return (
    <div className="flex h-[100dvh] overflow-hidden bg-bg">
      <Rail />
      <div className="flex flex-col flex-1 min-w-0">
        <ContextBar />
        <main className="flex-1 min-h-0 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Build the router**

```tsx
// renderer/app/router.tsx
// Browser history, unlike the kiosk's router which uses memory history and
// branches on window.location in root-view.tsx. Real routing is what lets the
// shell persist across navigation - the SSE connection and the React Query
// cache survive a route change, where a document load discards both.

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { Shell } from "./shell";
import { DESTINATIONS, NESTED_ROUTES } from "./destinations";
import { ErrorBoundaryView } from "../components/ui/error-boundary-view";

const rootRoute = createRootRoute({
  component: Shell,
  errorComponent: ErrorBoundaryView,
  notFoundComponent: () => (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <p className="text-title3 text-fg">Page not found</p>
      <p className="text-body text-fg-muted">Pick a destination from the sidebar.</p>
    </div>
  ),
});

const routes = [
  ...DESTINATIONS.map((d) =>
    createRoute({ getParentRoute: () => rootRoute, path: d.path, component: d.Component }),
  ),
  ...NESTED_ROUTES.map((r) =>
    createRoute({ getParentRoute: () => rootRoute, path: r.path, component: r.Component }),
  ),
];

const routeTree = rootRoute.addChildren(routes);

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export const router = createRouter({ routeTree, scrollRestoration: true });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

- [ ] **Step 9: Build the React root**

```tsx
// renderer/app/index.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "../components/ui/tooltip-provider";
import { Toaster } from "../components/ui/toast";
import { ConfirmHost } from "../components/ui/confirm-dialog";
import { router, queryClient } from "./router";
import "../styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
      <Toaster />
      <ConfirmHost />
    </QueryClientProvider>
  </React.StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.accept();
}
```

- [ ] **Step 10: Type-check, build, and drive it**

```bash
npm run type-check && npm run lint && npm run build
```
Expected: all clean.

Then drive the real thing — a route that renders is not a route that works:

```bash
npm run server &
until curl -sf http://localhost:8788/api/version > /dev/null; do sleep 1; done
for p in /history /patch /automation /integrations /baptism /scriptview; do
  printf '%-16s %s\n' "$p" "$(curl -s http://localhost:8788$p | grep -c 'renderer/app/index')"
done
kill %1
```
Expected: `1` for every path.

**Human check required.** Open `http://localhost:8788/history` in a browser and confirm: the rail renders with six destinations and the brand name; clicking between destinations does NOT reload the page (the network tab shows no new document request); the active destination is highlighted; the theme toggle state from `/settings` is respected.

- [ ] **Step 11: Commit**

```bash
git add renderer/app/
git commit -m "feat(shell): operator app with browser-history routing and a rail

The rail and the route tree are both generated from DESTINATIONS, and a test
asserts that set equals the server's OPERATOR_PATHS exactly - a rail entry the
server does not route is a link that leaves the shell, and a routed path with
no rail entry is an unreachable page.

Parity guard proved: removing the /integrations destination turns it red."
```

---

## Task 4: Shell chrome parity

**Files:**
- Create: `renderer/lib/use-theme.ts`, `renderer/lib/use-sidebar-collapsed.ts`, `renderer/components/ui/theme-toggle-pill.tsx`, `renderer/components/ui/build-label.tsx`
- Modify: `renderer/settings/settings-view.tsx` (import the extracted versions instead of its local copies), `renderer/app/rail.tsx`, `renderer/app/destinations.tsx`, `renderer/app/router.tsx`
- Test: `renderer/app/chrome-parity.test.tsx`

**Interfaces:**
- Consumes: `DESTINATIONS` from Task 3.
- Produces:
  - `useTheme(): { mode: ThemeMode; setMode(m: ThemeMode): void }` where `ThemeMode = "light" | "system" | "dark"`
  - `useSidebarCollapsed(): { collapsed: boolean; toggle(): void }`
  - `<ThemeTogglePill mode setMode vertical? />`
  - `buildLabel(updateStatus): string`
  - `Destination` gains `description: string`

The settings shell carries chrome that is *shell* behaviour rather than settings
behaviour. It is extracted rather than reimplemented, so the two shells share one
copy and cannot drift — and so Phase 1b inherits it for free. Extracting is also
what the repo's rule about the same shape in more than one place requires.

Work from the **Feature parity inventory** above. Two entries are marked
deliberately not carried, with reasons; every other row must end up implemented.

- [ ] **Step 1: Write the failing test**

```tsx
// renderer/app/chrome-parity.test.tsx
import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { DESTINATIONS } = await import("./destinations.js");
const { THEME_MODES } = await import("../lib/use-theme.js");
const { buildLabel } = await import("../components/ui/build-label.js");

after(() => {
  teardown();
});

describe("shell chrome parity", () => {
  test("the theme toggle offers all three modes, including system", () => {
    // The settings toggle is three-way. Shipping a two-way light/dark switch
    // silently removes "Match system", which is the default for anyone who
    // never touched it.
    assert.deepEqual([...THEME_MODES], ["light", "system", "dark"]);
  });

  test("every destination carries a description for its page header", () => {
    // Settings shows a subtitle under each section title (SECTION_DESC).
    // A destination with no description renders a bare heading and loses it.
    for (const d of DESTINATIONS) {
      assert.equal(typeof d.description, "string", `${d.label} has no description`);
      assert.ok(d.description.length > 0, `${d.label} has an empty description`);
    }
  });

  test("the build label carries version, track, commit and date", () => {
    // This string is what gets asked for when something needs diagnosing. A
    // label that degrades to just the version makes a support conversation
    // start with "what commit is that".
    const label = buildLabel({
      version: "1.10.1",
      branch: "beta",
      latestSha: "abc1234",
      latestDate: "2026-08-14T12:00:00.000Z",
    });
    assert.match(label, /1\.10\.1/);
    assert.match(label, /beta/);
    assert.match(label, /abc1234/);
    assert.match(label, /2026/);
  });

  test("the build label degrades without throwing when nothing is known yet", () => {
    // updateStatus is null until the first check returns. Rendering the footer
    // must not blow up the whole shell in that window.
    assert.equal(typeof buildLabel(null), "string");
    assert.equal(typeof buildLabel({ version: "1.10.1" }), "string");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="shell chrome parity"`
Expected: FAIL — `Cannot find module '../lib/use-theme.js'`.

- [ ] **Step 3: Extract the theme hook and its toggle**

Move `useTheme`, `THEME_STORAGE_KEY` and the mode list out of
`renderer/settings/settings-view.tsx` into `renderer/lib/use-theme.ts`, exporting
the modes so they can be asserted:

```ts
// renderer/lib/use-theme.ts
// Theme mode, shared by the settings panel and the operator app.
//
// Extracted from settings-view.tsx so the two shells cannot drift into
// offering different toggles. The pre-paint application still lives in each
// entry document's inline script (settings-window.html, app.html) - that has
// to run before React, or the page flashes the wrong theme on load.

import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "system" | "dark";

/** Order is the order they render in the pill. "system" is the default. */
export const THEME_MODES = ["light", "system", "dark"] as const;

export const THEME_STORAGE_KEY = "stage-utility-theme";
```

Keep the body of the existing `useTheme` implementation verbatim — it already
handles a `localStorage` that throws in private mode, and rewriting it would risk
a behaviour change this task is specifically meant to avoid.

Move `ThemeTogglePill` to `renderer/components/ui/theme-toggle-pill.tsx`
unchanged, including its `vertical` prop (the rail-collapsed layout needs it).

- [ ] **Step 4: Extract the collapse hook and the build label**

Move `useSidebarCollapsed` and `SIDEBAR_COLLAPSED_KEY` to
`renderer/lib/use-sidebar-collapsed.ts`, and `buildLabel` to
`renderer/components/ui/build-label.tsx`, both verbatim.

Then confirm the settings panel imports the extracted copies and holds no
duplicates:

```bash
grep -n "function useTheme\|function useSidebarCollapsed\|function buildLabel\|function ThemeTogglePill" renderer/settings/settings-view.tsx || echo "no local copies remain"
```
Expected: `no local copies remain`.

- [ ] **Step 5: Give every destination a description**

Add `description` to the `Destination` interface in
`renderer/app/destinations.tsx` and fill it for all six, reusing the wording
already in `SECTION_DESC` where one exists so the two surfaces agree:

```tsx
export interface Destination {
  path: string;
  label: string;
  /** Subtitle under the page title. Mirrors SECTION_DESC in settings, so the
   *  same surface is described the same way wherever it is reached from. */
  description: string;
  icon: ReactNode;
  Component: ComponentType;
}
```

Descriptions, matching the existing settings copy where it exists:

- `/patch` — `"Stage input & output patch — record it, and surface each week's to volunteers."`
- `/scriptview` — `"Named rundown column presets for the ScriptView dashboard."`
- `/history` — `"Every service you've run — timing and attendance."`
- `/baptism` — `"Time testimonies and baptisms live."`
- `/automation` — `"When something happens in Stage, do something to a device."`
- `/integrations` — `"Connect the gear and services that run your service."`

- [ ] **Step 6: Build the rail footer and the page header**

Extend `renderer/app/rail.tsx` with the footer, mirroring the settings layout
including its rail-aware collapsed variant:

```tsx
      <div className="mt-auto border-t border-line">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5 px-2 py-2.5">
            <ThemeTogglePill mode={theme.mode} setMode={theme.setMode} vertical />
            <button
              type="button"
              aria-label="Expand sidebar"
              onClick={toggle}
              className="rounded-lg p-1.5 text-fg-subtle hover:bg-fill-hover hover:text-fg"
            >
              <PanelLeftOpenIcon className="size-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            {/* The label truncates, so the hover carries the whole build
                identity - version, track, commit and date. That is what gets
                asked for when something needs diagnosing. */}
            <Tooltip label={buildLabel(updateStatus)} side="top">
              <span className="min-w-0 text-[11.5px] leading-none text-fg-subtle tabular-nums truncate">
                {updateStatus?.version ? `v${updateStatus.version}` : ""}
                {updateStatus?.branch ? ` · ${updateStatus.branch}` : ""}
              </span>
            </Tooltip>
            <div className="flex items-center gap-1.5 shrink-0">
              <ThemeTogglePill mode={theme.mode} setMode={theme.setMode} />
              <button
                type="button"
                aria-label="Collapse sidebar"
                onClick={toggle}
                className="rounded-lg p-1.5 text-fg-subtle hover:bg-fill-hover hover:text-fg max-sm:hidden"
              >
                <PanelLeftCloseIcon className="size-4" />
              </button>
            </div>
          </div>
        )}
      </div>
```

`updateStatus` comes from the same IPC the settings panel uses
(`invoke("update:getStatus")`); read it once in the rail with a `useEffect`, and
render the version as an empty string until it arrives rather than a placeholder.

Add the page header to `Shell`, above the `<Outlet/>`, reading the active
destination's `label` and `description`.

- [ ] **Step 7: Per-route error boundaries**

Give each route its own `errorComponent` in `renderer/app/router.tsx` rather than
only the root:

```tsx
  ...DESTINATIONS.map((d) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: d.path,
      component: d.Component,
      // Per route, not just the root: a render error inside History must not
      // blank the rail and strand the operator with no way out. Settings keyed
      // its boundary by section for the same reason.
      errorComponent: ErrorBoundaryView,
    }),
  ),
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npm test -- --test-name-pattern="shell chrome parity"`
Expected: PASS, 4 tests.

Then the whole suite: `npm test`
Expected: all pass — the settings panel now imports the extracted hooks, so a
mistake in the extraction shows up as a settings failure.

- [ ] **Step 9: Prove two guards fail on their bugs**

1. Change `THEME_MODES` to `["light", "dark"]`. The three-mode test must go RED.
   This is the exact regression the inventory exists to prevent. Restore it.
2. Remove the `description` from one destination. The description test must go
   RED naming that destination. Restore it.

- [ ] **Step 10: Walk the inventory**

Open the Feature parity inventory table and confirm each row marked **Carried**
is actually present in the running app. This is a human check — a test can assert
the theme toggle has three modes, but not that it is reachable, visible and
positioned where an operator will find it.

**Human check required**, at `http://localhost:8788/history`:

- the theme toggle shows three options and switching persists across a reload;
- the version and branch render, and hovering shows the full build identity;
- collapsing the rail persists across a reload, and the collapsed rail shows the
  vertical toggle rather than clipping the wide pill;
- at a narrow window the rail becomes a drawer with a title bar;
- each destination shows its title and description;
- clicking the already-active History entry resets it to its top view.

- [ ] **Step 11: Commit**

```bash
git add renderer/lib/use-theme.ts renderer/lib/use-sidebar-collapsed.ts \
        renderer/components/ui/theme-toggle-pill.tsx renderer/components/ui/build-label.tsx \
        renderer/app/ renderer/settings/settings-view.tsx
git commit -m "feat(shell): carry the settings chrome into the operator app

Theme toggle (three-way, including system), version + build-identity tooltip,
persisted rail collapse with its rail-aware layout, mobile drawer, per-page
header and per-route error boundaries.

Extracted rather than reimplemented - settings-view.tsx now imports the same
useTheme, useSidebarCollapsed, ThemeTogglePill and buildLabel, so the two
shells cannot drift and Phase 1b inherits them.

Two behaviours are deliberately NOT carried, both recorded in the plan's
parity inventory: nav group labels (six destinations do not need grouping;
they return in 1b) and escape-to-close (it closes the settings window; the
operator app is not a modal over anything).

Guards proved: cutting THEME_MODES to light/dark reddens the three-mode test,
and removing a destination's description reddens the header test."
```

---

## Task 5: The context bar

**Files:**
- Create: `renderer/app/context-bar.tsx`
- Test: `renderer/app/context-bar.test.tsx`

**Interfaces:**
- Consumes: `useDashboardState()` from `renderer/main/use-dashboard-state` (returns `{ state, isLoading, error, pcoLive, propresenter }`); `computePcoTimer(pcoLive, now, skewMs)` and `fmtDuration(totalSec)` from `renderer/main/pco-timer`; `useResyncOn` from `renderer/lib/use-resync-on`.
- Produces: `<ContextBar/>`.

**Do not write new timer maths.** `computePcoTimer` already mirrors PCO's semantics exactly — counts down to the service start in `"preservice"` mode, counts down each item's length in `"item"` mode, goes negative on overrun, counts *up* for a live item with no set length — and `fmtDuration` already formats days, `h:mm:ss` and the negative sign. The dashboard and the stage display both use them. A third implementation in the context bar would be a fourth place for the same bug.

**`pcoLive` is not on `StageState`.** It arrives on the `pco:live` SSE channel and is exposed by `useDashboardState()`. Skew is corrected using `pcoLive.serverNow`, which the server sends for exactly this purpose.

Phase 1a ships a fixed item set. The configurable registry is Phase 3 — building it now would be a registry with one consumer and no second implementation to generalise from.

- [ ] **Step 1: Write the failing test**

The timer maths is already covered by `pco-timer`'s own tests, so this covers what is genuinely new: that the bar reports live state only when there is one, and that it does not invent its own formatting.

```tsx
// renderer/app/context-bar.test.tsx
import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { contextBarState } = await import("./context-bar.js");

after(() => {
  teardown();
});

const LIVE_ITEM = {
  mode: "item" as const,
  currentItemId: "i1",
  label: "Message",
  lengthSec: 1200,
  liveStartAt: "2026-08-14T14:00:00.000Z",
  targetAt: null,
  serverNow: "2026-08-14T14:05:00.000Z",
  currentItemTitle: "Message",
  nextItemTitle: "Closing",
  serviceTimeId: "st1",
  serviceTimeStartsAt: "2026-08-14T13:30:00.000Z",
};

describe("context bar state", () => {
  test("reports not-live when there is no live payload at all", () => {
    const s = contextBarState(null, Date.parse("2026-08-14T14:05:00.000Z"), 0);
    assert.equal(s.isLive, false);
    assert.equal(s.timerText, null);
  });

  test("reports not-live in mode none, even though a payload exists", () => {
    // A pco:live broadcast with mode "none" is the server saying the service
    // ENDED. Treating any payload as live leaves a Live pill lit all week.
    const s = contextBarState({ ...LIVE_ITEM, mode: "none" }, Date.now(), 0);
    assert.equal(s.isLive, false);
    assert.equal(s.timerText, null);
  });

  test("reports live with the current item and a formatted timer", () => {
    const s = contextBarState(LIVE_ITEM, Date.parse("2026-08-14T14:05:00.000Z"), 0);
    assert.equal(s.isLive, true);
    assert.equal(s.itemTitle, "Message");
    // 1200s length, 300s elapsed -> 15:00 remaining, via fmtDuration.
    assert.equal(s.timerText, "15:00");
  });

  test("applies clock skew, so a drifted browser matches the server", () => {
    // The browser is 60s BEHIND the server. Without applying skew the timer
    // reads a minute long for the whole service.
    const browserNow = Date.parse("2026-08-14T14:04:00.000Z");
    const skewMs = 60_000;
    const s = contextBarState(LIVE_ITEM, browserNow, skewMs);
    assert.equal(s.timerText, "15:00");
  });

  test("shows an overrun as negative rather than clamping it", () => {
    // PCO counts past zero when an item runs long, and so must this - an
    // operator needs to see HOW far over, not a frozen 0:00.
    const s = contextBarState(LIVE_ITEM, Date.parse("2026-08-14T14:25:00.000Z"), 0);
    assert.equal(s.isOver, true);
    assert.ok(s.timerText?.startsWith("−"), `expected a negative timer, got ${s.timerText}`);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="context bar state"`
Expected: FAIL — `Cannot find module './context-bar.js'`.

- [ ] **Step 3: Implement**

```tsx
// renderer/app/context-bar.tsx
// Live service state, above every operator surface.
//
// The state is not new - use-dashboard-state already carries it - but until now
// it existed only on whichever View happened to render it, so /patch could not
// tell a service was live. Hoisting it here is what makes separate pages read
// as one program.
//
// The timer maths is NOT reimplemented here. computePcoTimer already mirrors
// PCO's semantics (counts down to service start pre-service, down each item's
// length while live, negative on overrun, up for an item with no set length)
// and fmtDuration already formats it. The dashboard and the stage display use
// the same pair; a third copy would be a third place for the same bug.
//
// The item set is fixed in Phase 1a. It becomes a configurable registry in
// Phase 3, alongside integration health and recording status; generalising now
// would produce a registry with one consumer and nothing to generalise from.

import { useEffect, useState } from "react";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useDashboardState } from "../main/use-dashboard-state";
import { computePcoTimer, fmtDuration } from "../main/pco-timer";

export interface ContextBarState {
  isLive: boolean;
  isOver: boolean;
  /** The live item's title, or the pre-service label. */
  itemTitle: string | null;
  /** Formatted countdown, or null when nothing is live. */
  timerText: string | null;
}

/**
 * The bar's derived state. Pure, so it is testable without rendering.
 *
 * `skewMs` is `Date.parse(pcoLive.serverNow) - Date.now()` at the time the last
 * pco:live arrived — the server sends serverNow for exactly this. A kiosk or
 * laptop whose clock has drifted otherwise runs a timer that disagrees with the
 * one on the wall.
 */
export function contextBarState(
  pcoLive: PcoLiveDTO | null,
  now: number,
  skewMs: number,
): ContextBarState {
  const timer = computePcoTimer(pcoLive, now, skewMs);
  if (!timer) return { isLive: false, isOver: false, itemTitle: null, timerText: null };
  return {
    isLive: true,
    isOver: timer.over,
    itemTitle: timer.label,
    timerText: fmtDuration(timer.seconds),
  };
}

export function ContextBar() {
  const { state, pcoLive } = useDashboardState();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    // Cleanup is load-bearing: the operator app is a persistent shell, so an
    // interval that outlives its component runs for the whole service.
    return () => clearInterval(id);
  }, []);

  // Skew between this client and the server, recomputed whenever a pco:live
  // arrives. Same pattern as dashboard-view.tsx.
  const [skewMs, setSkewMs] = useState(0);
  useResyncOn([pcoLive?.serverNow], () => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  });

  const bar = contextBarState(pcoLive, now, skewMs);

  return (
    <header className="flex items-center gap-4 h-12 shrink-0 px-4 border-b border-line bg-surface">
      <span className="text-body text-fg-muted truncate">
        {state?.serviceTypeName ?? "No service type"}
      </span>

      {state?.planTitle && (
        <span className="text-body text-fg truncate">{state.planTitle}</span>
      )}

      {bar.isLive && (
        <span className="flex items-center gap-3 ml-auto shrink-0">
          {bar.itemTitle && (
            <span className="text-body text-fg-muted truncate max-w-56">{bar.itemTitle}</span>
          )}
          <span className="size-2 rounded-full bg-live-9" aria-hidden />
          <span className="text-caption1 font-medium uppercase tracking-wider text-live-11">
            Live
          </span>
          <span
            className={`text-body font-mono tabular-nums ${bar.isOver ? "text-danger-11" : "text-fg"}`}
          >
            {bar.timerText}
          </span>
        </span>
      )}
    </header>
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- --test-name-pattern="context bar state"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the skew and mode guards fail on their bugs**

Two separate proofs, both required:

1. Change `contextBarState` to call `computePcoTimer(pcoLive, now, 0)`, ignoring skew. The "applies clock skew" test must go RED. Restore it.
2. Change the early return to `if (!pcoLive) return {...}` — i.e. treat any payload as live rather than trusting `computePcoTimer`'s `mode === "none"` check. The "reports not-live in mode none" test must go RED. Restore it.

- [ ] **Step 6: Confirm the token and type names are real**

```bash
grep -n "color-danger-11\|color-live-9\|color-live-11" renderer/styles.css
grep -n "serviceTypeName\|planTitle" main/types/state.ts
```
Both must return matches. `PcoLiveDTO` is a global ambient type in the renderer (see `renderer/types.d.ts`), so it needs no import — confirm with `npm run type-check`.

- [ ] **Step 7: Verify against a live server**

```bash
npm run type-check && npm run lint && npm test
```
Expected: all clean.

**Human check required.** Open `http://localhost:8788/history`, confirm the context bar shows the service type and plan. If a PCO service is live (or can be simulated), confirm the Live pill and a timer that advances once per second, and that navigating between destinations does not reset it.

- [ ] **Step 8: Commit**

```bash
git add renderer/app/context-bar.tsx renderer/app/context-bar.test.tsx
git commit -m "feat(shell): live service context above every operator surface

The state already existed; it just lived only on whichever View rendered it,
so /patch could not tell a service was live.

Reuses computePcoTimer + fmtDuration rather than writing a third copy of the
timer maths - the dashboard and stage display are the other two.

Two guards proved: dropping the skew argument reddens the drifted-clock case,
and treating any pco:live payload as live (instead of honouring mode 'none')
reddens the service-ended case."
```

---

## Task 6: Collapse the two real duplicates

**Files:**
- Delete: `renderer/main/history-view.tsx`, `renderer/main/baptism-operator-view.tsx`
- Modify: `renderer/main/root-view.tsx`
- Modify: `renderer/settings/settings-view.tsx`
- Modify: `docs/display-urls.md`

**Interfaces:**
- Consumes: the routes from Task 3.
- Produces: `root-view.tsx` handling only `/` and `/display-*`.

Only History and Baptisms are duplicates. `patch-view.tsx` and `scriptview-index-view.tsx` are distinct surfaces and are kept — the shell routes render them.

- [ ] **Step 1: Write the failing test**

```tsx
// Append to renderer/app/routes.test.tsx
describe("the kiosk no longer serves operator surfaces", () => {
  test("root-view branches only on the display picker and kiosk displays", async () => {
    // root-view.tsx used to switch on window.location.pathname for /history,
    // /patch, /baptism and /scriptview. Those are the operator app's now, and
    // leaving a branch behind means two components can answer one URL
    // depending on which document the server served.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../main/root-view.tsx", import.meta.url),
      "utf8",
    );
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const gone of ["HistoryView", "BaptismOperatorView", "PatchView", "ScriptViewIndex"]) {
      assert.equal(
        code.includes(gone),
        false,
        `root-view.tsx still renders ${gone}; the operator app owns that route`,
      );
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="kiosk no longer serves"`
Expected: FAIL — root-view.tsx still references all four.

- [ ] **Step 3: Strip the kiosk's operator branches**

Replace `renderer/main/root-view.tsx` with:

```tsx
import { Outlet } from "@tanstack/react-router";
import { DisplayPickerView } from "./display-picker-view";

export function RootView() {
  // The kiosk router uses memory history (ignores the URL), so branch on the
  // real path: "/" is the display picker, everything else is "/display-N" and
  // renders the kiosk StageView through the Outlet.
  //
  // The operator surfaces (/history, /patch, /baptism, /scriptview) used to be
  // handled here as chrome-free islands. They belong to the operator app now
  // (app.html), which the server routes them to - see operator-paths.ts.
  const slug = window.location.pathname.replace(/^\/+|\/+$/g, "");

  return (
    <div className="h-full w-full overflow-hidden kiosk-surface">
      {slug === "" ? <DisplayPickerView /> : <Outlet />}
    </div>
  );
}
```

- [ ] **Step 4: Delete the two wrappers**

```bash
git rm renderer/main/history-view.tsx renderer/main/baptism-operator-view.tsx
```

- [ ] **Step 5: Point the settings links at the shell**

In `renderer/settings/settings-view.tsx`, replace the `SECTION_PAGE` block:

```ts
/**
 * Tabs whose content also lives in the operator app, and what to call the link.
 *
 * History and Baptisms are the SAME component in both places, so these links
 * are the route that replaced the deleted standalone wrapper. Patch and
 * ScriptView are different surfaces - the volunteer patch view and the rundown
 * viewer - so those links lead to a genuinely separate page, not a twin.
 */
const SECTION_PAGE: Record<string, { path: string; label: string } | undefined> = {
  scriptview: { path: "/scriptview", label: "Open ScriptView" },
  patch: { path: "/patch", label: "Open patch sheet" },
  "service-history": { path: "/history", label: "Open history" },
  baptisms: { path: "/baptism", label: "Open operator page" },
};
```

(The paths are unchanged; only the comment is corrected. Verify the block still compiles and that nothing else imported the deleted files:)

```bash
grep -rn "history-view\|baptism-operator-view" renderer/ main/ || echo "no dangling imports"
```
Expected: `no dangling imports`.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npm test -- --test-name-pattern="kiosk no longer serves"`
Expected: PASS.

Then the whole suite: `npm test`
Expected: all pass.

- [ ] **Step 7: Prove the guard fails on its bug**

Re-add `import { HistoryView } from "./history-view";` and a `slug === "history"` branch to `root-view.tsx`. The test must go RED naming `HistoryView`. Remove it and confirm green.

Note the guard reads source text, which this repo has been burned by. It is acceptable here only because it strips comment lines and matches on component identifiers that prose would not contain, and because it is paired with the live check in Step 8.

- [ ] **Step 8: Verify the URLs end-to-end**

```bash
npm run build && npm run server &
until curl -sf http://localhost:8788/api/version > /dev/null; do sleep 1; done
for p in / /display-1 /history /baptism /patch /scriptview; do
  doc=$(curl -s http://localhost:8788$p | grep -o 'renderer/[a-z]*/index' | head -1)
  printf '%-14s %s\n' "$p" "$doc"
done
kill %1
```
Expected: `/` and `/display-1` on `renderer/main/index`; the other four on `renderer/app/index`.

**Human check required.** Confirm a wall display at `/display-1` still renders correctly and is unchanged.

- [ ] **Step 9: Document the URLs**

Add to `docs/display-urls.md`, under the existing display-URL table:

```markdown
## Operator surfaces

These render in the operator app, with navigation and the live context bar.
They follow the light/dark theme, unlike the always-dark display URLs above.

| URL | What it is |
| --- | --- |
| `/history` | Service history and attendance |
| `/patch` | This week's stage patch, for volunteers |
| `/scriptview` | Rundown viewer |
| `/baptism` | Baptism operator |
| `/automation` | Automation rules |
| `/integrations` | Connected devices and services |
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(shell): the operator app owns the operator URLs

history-view.tsx (38 lines) and baptism-operator-view.tsx (35) were wrappers
around ServiceHistorySection and BaptismOperator, the same components their
settings tabs render, so both are deleted and the routes render the component
directly. patch-view.tsx and scriptview-index-view.tsx are NOT duplicates -
the volunteer patch view and the rundown viewer - and are kept.

root-view.tsx keeps only the display picker and the kiosk Outlet.

Guard proved: re-adding a HistoryView branch to root-view.tsx turns it red."
```

---

## Task 7: Whole-branch verification

**Files:** none changed unless a check fails.

- [ ] **Step 1: Run every check and read the output**

```bash
npm run lint && npm run type-check && npm test && npm run build
```
Expected: four clean runs. Do not proceed on a warning you have not read.

- [ ] **Step 2: Confirm the bundle split held**

```bash
node -e "
const fs=require('fs');
const files=fs.readdirSync('build/renderer/assets');
console.log('asset chunks:', files.filter(f=>f.endsWith('.js')).length);
" 
ls -la build/renderer/*.html
```
Expected: three HTML documents. The operator app must not have been folded into the kiosk chunk — confirm `app.html` references a different entry chunk than `index.html`:

```bash
grep -o 'assets/[^"]*\.js' build/renderer/index.html build/renderer/app.html
```
Expected: different filenames on the two lines.

- [ ] **Step 3: Kill any stray dev server by port, never by name**

```bash
lsof -ti tcp:8788 | xargs -r kill
```

Killing by an env-var prefix does not work here — the prefix is not in the process command line, so the old server survives and the next run tests stale code.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/operator-shell
gh pr create --base beta --title "feat(shell): operator app with routing, rail and context bar" --body "$(cat <<'PRBODY'
Phase 1a of docs/design/app-shell-redesign.md. Additive: the kiosk and the settings panel are untouched.

A third entry point (`app.html`) with browser-history routing serves `/patch`, `/history`, `/baptism`, `/scriptview`, `/automation` and `/integrations` inside a shell with a persistent rail and a live context bar. Navigating between them no longer reloads the document, so the SSE connection and the React Query cache survive a route change.

- `operator-paths.ts` is the one table both the dev plugin and `remote-server.ts` route from; they have drifted before.
- The rail and the route tree are generated from one `DESTINATIONS` list, and a test asserts that set equals the server's operator paths exactly.
- `history-view.tsx` and `baptism-operator-view.tsx` were wrappers around the same components their settings tabs render, and are deleted. `patch-view.tsx` and `scriptview-index-view.tsx` are distinct surfaces and are kept.

Guards proved in-session: relaxing `isOperatorPath` to a bare `startsWith` reddens the `/historyfoo` case; removing a destination reddens the rail/server parity test; dropping the elapsed-timer clamp reddens the clock-skew case; re-adding a `HistoryView` branch reddens the root-view guard.

Human-checked: navigation does not reload, the active rail item highlights, the theme toggle is respected, and `/display-1` is unchanged.
PRBODY
)"
```

- [ ] **Step 5: Report the check results**

Wait for CI and report what actually ran. Do not claim green from an older commit's badge.

---

## Out of scope for Phase 1a

Deliberately deferred, so the reviewer does not flag them as gaps:

- **Home at `/`** — Phase 2. `/` stays the display picker.
- **Views and Outputs merging into Screens** — Phase 2.
- **Settings dissolving into routes** — Phase 1b. `/settings` keeps its 12 tabs and its own document.
- **The configurable context-bar registry** — Phase 3. Phase 1a ships a fixed item set.
- **Route-level code splitting** — worth doing, but it belongs with Phase 1b when the settings sections (the heavy ones: the layout editor, the history charts) join the bundle. Splitting six light routes now optimises nothing.
- **`View.surface`, Output modes, control objects** — Phase 3.
- **Nav group labels** — six destinations do not need Content/Screens/Devices grouping; the groups return in 1b when the rail reaches roughly ten items. Recorded in the parity inventory.
- **Escape-to-close** — closes the settings *window*; the operator app is the app, not a modal over it. Recorded in the parity inventory.
