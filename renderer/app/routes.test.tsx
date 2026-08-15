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
