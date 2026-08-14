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
