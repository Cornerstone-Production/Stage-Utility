// Every route the app registers has a name in the chrome.
//
// A console had none. `/consoles/<id>` is built from the operator's own Views,
// so it appeared in neither of the two static-table matchers the shell used:
// the desktop header rendered nothing and the mobile top bar was a hamburger
// followed by an empty row. `/history` — the read-only link handed to
// volunteers — had the same hole for a different reason: `/history/manage` does
// not prefix-match it.
//
// So this walks the REAL router's registered route tree, not a hand-kept list
// and not source text. A comment naming a route cannot satisfy it, and a route
// added to router.tsx without a title fails here rather than shipping blank.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated — a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { router } = await import("./router.js");
const { MOVED_ROUTES } = await import("./redirects.js");
const { consolePageFor, consolePages, resolvePage } = await import("./active-page.js");
const { PageHeader } = await import("./page-header.js");
const { PageActionsProvider } = await import("./page-actions.js");

after(() => {
  cleanup();
  teardown();
});

/** Invented, as everything in this repo's fixtures is. */
const CONSOLE_ID = "view-monitor-world";
const CONSOLE_NAME = "Monitor World";

const VIEWS = [
  // Home is a console View and must NOT become a console page — the rail once
  // carried two Home entries because of exactly this.
  { id: "home", name: "Home", kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: CONSOLE_ID, name: CONSOLE_NAME, kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "view-lobby", name: "Lobby", kind: "slots", createdAt: "2026-01-01T00:00:00.000Z" },
] as unknown as NonNullable<Parameters<typeof consolePages>[0]>;

const CONSOLES = consolePages(VIEWS);

/** Sample values for a route pattern's params, so a dynamic route can be walked
 *  as a real URL. Invented ids, never a real service type. */
const PARAMS: Record<string, string> = {
  $viewId: CONSOLE_ID,
  $serviceType: "weekend-gathering",
  $layout: "audio",
};

function fill(pattern: string): string {
  return pattern
    .split("/")
    .map((seg) => (seg.startsWith("$") ? (PARAMS[seg] ?? `missing-${seg}`) : seg))
    .join("/");
}

/** Every path the router actually registers, from the route tree itself. */
const REGISTERED: string[] = (
  (router.routeTree.children ?? []) as { fullPath?: string }[]
).map((r) => r.fullPath ?? "").filter(Boolean).map((p) => (p.length > 1 ? p.replace(/\/$/, "") : p));

/**
 * Routes that deliberately have no name: their component navigates away the
 * moment it mounts, so a title would flash and vanish.
 *
 * Derived from MOVED_ROUTES rather than restated, then asserted as an exact set
 * — a new route cannot join this exemption by accident.
 */
const REDIRECTS = new Set(["/settings", ...Object.keys(MOVED_ROUTES)]);

describe("the route table", () => {
  test("the tree really is the router's, and it has every path", () => {
    // If this ever reads empty, every assertion below passes vacuously.
    assert.ok(REGISTERED.length >= 20, `only ${REGISTERED.length} routes registered`);
    for (const p of ["/", "/consoles/$viewId", "/history", "/screens/$viewId/edit"]) {
      assert.ok(REGISTERED.includes(p), `${p} is not in the router's route tree`);
    }
  });

  test("the redirect exemption is exactly the three paths that redirect", () => {
    assert.deepEqual([...REDIRECTS].sort(), ["/displays", "/settings", "/views"]);
  });

  test("there are exactly three dynamic routes", () => {
    // Named so the count is a decision. A fourth arriving without a title is
    // what this file exists to catch.
    const dynamic = REGISTERED.filter((p) => p.includes("$")).sort();
    assert.deepEqual(dynamic, [
      "/consoles/$viewId",
      "/screens/$viewId/edit",
      "/scriptview/$serviceType/$layout",
    ]);
  });
});

describe("every registered route resolves a title", () => {
  test("no route but a redirect leaves the chrome blank", () => {
    const blank = REGISTERED.filter((pattern) => {
      if (REDIRECTS.has(pattern)) return false;
      const active = resolvePage(fill(pattern), CONSOLES);
      return !active?.page.label;
    });
    assert.deepEqual(
      blank,
      [],
      "these routes render a hamburger and an empty row on a phone — give the " +
        "route a label in NESTED_ROUTES, or a destination it sits under",
    );
  });

  test("seventeen of the twenty registered routes are titled", () => {
    // An EXACT count, not a floor. A floor with slack is how three of these went
    // untitled with the suite green.
    const titled = REGISTERED.filter((p) => resolvePage(fill(p), CONSOLES)?.page.label);
    assert.equal(REGISTERED.length, 20);
    assert.equal(titled.length, 17);
  });
});

describe("a console is named after its View", () => {
  test("the resolver answers with the operator's own name for it", () => {
    // THE bug. Before this, /consoles/<id> matched nothing and the label was
    // undefined on both surfaces.
    const active = resolvePage(`/consoles/${CONSOLE_ID}`, CONSOLES);
    assert.equal(active?.page.label, CONSOLE_NAME);
    assert.equal(active?.exact, true, "a console owns the shell's heading");
  });

  test("Home is not one of them", () => {
    assert.deepEqual(CONSOLES.map((c) => c.path), [`/consoles/${CONSOLE_ID}`]);
  });

  test("a console that no longer exists names nothing rather than something wrong", () => {
    assert.equal(resolvePage("/consoles/view-deleted", CONSOLES), null);
  });

  test("the rail and the header read the same name from the same helper", () => {
    // Two lists is how a renamed console would light up the rail as one thing
    // and title the page as another.
    const view = VIEWS.find((v) => v.id === CONSOLE_ID)!;
    assert.deepEqual(consolePageFor(view), CONSOLES[0]);
  });
});

describe("exact versus prefix", () => {
  test("a child route takes the section's name but not its heading", () => {
    // The layout editor and a ScriptView plan each draw their own heading, so
    // the shell names the section on the phone and stays out of the way on the
    // desktop.
    for (const [pattern, section] of [
      ["/screens/$viewId/edit", "Screens"],
      ["/scriptview/$serviceType/$layout", "ScriptView"],
      ["/patch/edit", "Patch"],
    ] as const) {
      const active = resolvePage(fill(pattern), CONSOLES);
      assert.equal(active?.page.label, section, `${pattern} lost its section name`);
      assert.equal(active?.exact, false, `${pattern} would draw a second title`);
    }
  });

  test("the volunteers' history is its own page, not a child of the operator's", () => {
    const active = resolvePage("/history", CONSOLES);
    assert.equal(active?.page.label, "History");
    assert.equal(active?.exact, true);
    // And the operator's own page still wins its own URL.
    assert.equal(resolvePage("/history/manage", CONSOLES)?.page.path, "/history/manage");
  });

  test("an unrouted URL claims nothing, so Home does not swallow a 404", () => {
    assert.equal(resolvePage("/nonsense", CONSOLES), null);
  });
});

describe("the desktop header draws what the resolver found", () => {
  const draw = (pathname: string) =>
    render(
      <PageActionsProvider>
        <PageHeader active={resolvePage(pathname, CONSOLES)} />
      </PageActionsProvider>,
    );

  test("a console's name is the page's h1", () => {
    const { container } = draw(`/consoles/${CONSOLE_ID}`);
    assert.equal(container.querySelector("h1")?.textContent, CONSOLE_NAME);
    // And no subtitle line: a console wants the height.
    assert.equal(container.querySelector("p"), null);
    cleanup();
  });

  test("a destination keeps its title and its subtitle", () => {
    const { container } = draw("/screens");
    assert.equal(container.querySelector("h1")?.textContent, "Screens");
    assert.ok((container.querySelector("p")?.textContent ?? "").length > 0);
    cleanup();
  });

  test("a child route draws no header at all", () => {
    const { container } = draw(`/screens/${CONSOLE_ID}/edit`);
    // Asserted as a boolean: an HTMLElement in the failure message prints the
    // whole React fiber and buries what went wrong.
    assert.equal(
      !!container.querySelector("header"),
      false,
      "the editor draws its own heading; a second one above it is the bug",
    );
    cleanup();
  });
});
