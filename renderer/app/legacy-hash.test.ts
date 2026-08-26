import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { legacyHashRoute, LEGACY_SECTION_IDS, SETTINGS_INDEX_ROUTE } = await import("./legacy-hash.js");
const { ALL_DESTINATIONS } = await import("./destinations.js");

after(() => teardown());

describe("legacy settings hash links", () => {
  test("every old section id resolves to a route", () => {
    // These are in operators' bookmarks and in the Connect tab's
    // copy-to-clipboard list. A missing one is a dead link for someone who did
    // exactly what the app told them to.
    for (const id of LEGACY_SECTION_IDS) {
      const target = legacyHashRoute(`#${id}`);
      assert.ok(target, `#${id} has no route`);
      assert.ok(target.startsWith("/"), `#${id} maps to "${target}", which is not a path`);
    }
  });

  test("every target is a route that actually exists", () => {
    // A redirect to a path with no route is a 404 with extra steps.
    const known = new Set(ALL_DESTINATIONS.map((d) => d.path));
    for (const id of LEGACY_SECTION_IDS) {
      const target = legacyHashRoute(`#${id}`)!;
      assert.ok(known.has(target), `#${id} redirects to ${target}, which is not a routed destination`);
    }
    assert.ok(known.has(SETTINGS_INDEX_ROUTE), "the /settings landing route must exist");
  });

  test("works with or without the leading hash", () => {
    assert.equal(legacyHashRoute("#advanced"), legacyHashRoute("advanced"));
  });

  test("an unrecognised hash is left alone", () => {
    // A hash we do not own belongs to something else on the page - an anchor,
    // another tool's state. Redirecting it would hijack it.
    assert.equal(legacyHashRoute("#something-else"), null);
    assert.equal(legacyHashRoute(""), null);
  });

  test("covers every section the old panel had", () => {
    // Asserted as an exact count, not a floor. A floor with slack is how a
    // section goes missing and nobody notices until a bookmark breaks.
    assert.equal(LEGACY_SECTION_IDS.length, 12);
  });
});
