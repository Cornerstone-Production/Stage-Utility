import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { DESTINATIONS, SETTINGS_DESTINATIONS, ALL_DESTINATIONS, NAV_GROUPS, UNGROUPED_PATHS } = await import("./destinations.js");
const { isOperatorPath } = await import("../../main/services/routes/operator-paths.js");
const { OPERATOR_PATHS } = await import("../../main/services/routes/operator-paths.js");

after(() => {
  teardown();
});

describe("operator destinations", () => {
  test("every destination is a path the server routes to the operator app", () => {
    // A rail entry the server does not claim renders the kiosk instead: the
    // link looks right, and clicking it leaves the shell entirely.
    // Asked through isOperatorPath rather than the raw list, because "/" is
    // deliberately special-cased there: as a list entry it would prefix-match
    // every path and claim /display-N, blacking out every wall screen.
    for (const d of ALL_DESTINATIONS) {
      assert.ok(isOperatorPath(d.path), `${d.path} is in the rail but the server does not route it`);
    }
  });

  test("every operator path the server claims has a destination", () => {
    // The reverse gap is a page that exists and is unreachable. Asserted as an
    // EXACT set rather than a count, so adding one on either side fails loudly.
    // "/" is excluded from both sides: it is routed by the special case above,
    // not by the list. Every OTHER operator path must have a destination.
    const railTops = new Set(
      ALL_DESTINATIONS.filter((d) => d.path !== "/").map((d) => `/${d.path.split("/")[1]}`),
    );
    // Retired paths are routed for their REDIRECTS (see redirects.tsx) and
    // deliberately have no rail entry: /views and /displays merged into
    // /screens. They stay routed so bookmarks land.
    //
    // /plan is NOT among them any more. It folded into Home in Phase 2 and came
    // back out when Home became a grid — a fixed block of PCO controls is
    // furniture on a page whose whole point is that the operator arranges it.
    const retired = new Set(["/views", "/displays"]);
    // /consoles has no STATIC destination: its rail entries are one per console
    // the operator built, derived from state in rail.tsx. The server must still
    // claim the path or a direct load serves the kiosk bundle — which is exactly
    // the bug that put it here.
    const dynamic = new Set(["/consoles"]);
    const expected = OPERATOR_PATHS.filter((p) => !retired.has(p) && !dynamic.has(p));
    assert.deepEqual(
      [...railTops].sort(),
      [...expected].sort(),
      "the rail and the server's operator paths must be the same set",
    );
  });

  test("a console produces a rail entry, so /consoles is not an empty exemption", async () => {
    // The exemption above says console rail entries come from state. This checks
    // that claim by RUNNING the derivation the rail and the shell both call,
    // rather than by reading rail.tsx for a string — a source scan is satisfied
    // by a comment, and this one was, right up until the derivation moved file.
    const { consolePages } = await import("./active-page.js");
    const views = [
      { id: "home", name: "Home", kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "view-monitor-world", name: "Monitor World", kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "view-lobby", name: "Lobby", kind: "slots", createdAt: "2026-01-01T00:00:00.000Z" },
    ] as unknown as Parameters<typeof consolePages>[0];
    // Exactly one: the slots View is not a console, and Home is filtered out.
    assert.deepEqual(
      consolePages(views).map((p) => p.path),
      ["/consoles/view-monitor-world"],
      "consoles no longer produce /consoles/<id> entries from state",
    );
  });

  test("paths and labels are unique", () => {
    assert.equal(new Set(ALL_DESTINATIONS.map((d) => d.path)).size, ALL_DESTINATIONS.length);
    assert.equal(new Set(ALL_DESTINATIONS.map((d) => d.label)).size, ALL_DESTINATIONS.length);
  });

  test("every work destination appears in exactly one nav group", () => {
    // In no group it renders outside the list; in two it renders twice. Both
    // are silent - the rail simply looks wrong, with nothing failing.
    const grouped = NAV_GROUPS.flatMap((g) => g.paths);
    // Home sits above the groups rather than inside one - it is the front door,
    // not a member of a category.
    for (const d of DESTINATIONS.filter((d) => !UNGROUPED_PATHS.includes(d.path))) {
      const count = grouped.filter((p) => p === d.path).length;
      assert.equal(count, 1, `${d.path} appears in ${count} nav groups`);
    }
  });

  test("nav groups name no path that is not a destination", () => {
    const known = new Set(DESTINATIONS.map((d) => d.path));
    for (const g of NAV_GROUPS) {
      for (const p of g.paths) {
        assert.ok(known.has(p), `nav group "${g.label}" lists ${p}, which is not a destination`);
      }
    }
  });

  test("settings destinations all live under /settings", () => {
    // The split is the point of the phase: work in the rail, configuration
    // under Settings. One leaking out puts a config page back among the work.
    for (const d of SETTINGS_DESTINATIONS) {
      assert.ok(d.path.startsWith("/settings/"), `${d.path} is not under /settings`);
    }
    for (const d of DESTINATIONS) {
      assert.ok(!d.path.startsWith("/settings"), `${d.path} is work but sits under /settings`);
    }
  });

  test("no destination label carries an emoji", () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const d of ALL_DESTINATIONS) {
      assert.equal(emoji.test(d.label), false, `${d.label} contains an emoji`);
    }
  });
});

describe("the kiosk no longer serves operator surfaces", () => {
  test("root-view renders only the display picker and the kiosk outlet", async () => {
    // root-view.tsx used to switch on window.location.pathname for /history,
    // /patch, /baptism and /scriptview. Those belong to the operator app now,
    // and a branch left behind means two components can answer one URL
    // depending on which document the server happened to serve.
    //
    // This reads source, which this repo has been burned by. It is acceptable
    // only because it strips whole-line comments and matches on component
    // identifiers that prose would not contain - and because the routing is
    // also driven against the real server in the same change.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../main/root-view.tsx", import.meta.url), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    for (const gone of ["HistoryView", "BaptismOperatorView", "PatchView", "ScriptViewIndex", "ScriptViewPlan"]) {
      assert.equal(
        code.includes(gone),
        false,
        `root-view.tsx still renders ${gone}; the operator app owns that route`,
      );
    }
  });

  test("the two duplicate wrappers are gone from the tree", async () => {
    // history-view.tsx and baptism-operator-view.tsx wrapped the very
    // components their settings tabs render. Leaving one behind is a second
    // copy that drifts. patch-view.tsx and scriptview-index-view.tsx are NOT
    // duplicates and must survive - they are the volunteer patch view and the
    // rundown viewer.
    const fs = await import("node:fs/promises");
    const exists = async (rel: string) => {
      try {
        await fs.access(new URL(rel, import.meta.url));
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(await exists("../main/history-view.tsx"), false, "history-view.tsx must be deleted");
    assert.equal(await exists("../main/baptism-operator-view.tsx"), false, "baptism-operator-view.tsx must be deleted");
    assert.equal(await exists("../main/patch-view.tsx"), true, "patch-view.tsx is a distinct surface and must stay");
    assert.equal(await exists("../main/scriptview-index-view.tsx"), true, "scriptview-index-view.tsx is a distinct surface and must stay");
  });
});

describe("retired paths still land somewhere", () => {
  test("every moved route points at a destination that exists", async () => {
    // A redirect to a path with no route is a 404 with extra steps - and these
    // are paths that SHIPPED, so they are in bookmarks and in Getting Started.
    const { MOVED_ROUTES } = await import("./redirects.js");
    const known = new Set(ALL_DESTINATIONS.map((d) => d.path));
    for (const [from, to] of Object.entries(MOVED_ROUTES)) {
      assert.ok(known.has(to), `${from} redirects to ${to}, which is not a routed destination`);
    }
  });

  test("no retired path is also a live destination", () => {
    // Both a redirect and a destination for one path is ambiguous, and which
    // wins depends on route order rather than intent.
    const known = new Set(ALL_DESTINATIONS.map((d) => d.path));
    for (const from of ["/views", "/displays"]) {
      assert.equal(known.has(from), false, `${from} is retired but still a destination`);
    }
  });
});
