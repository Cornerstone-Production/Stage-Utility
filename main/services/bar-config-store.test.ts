// The bar's two saved orders, and the ways one of them can eat the other.
//
// DRIVEN THROUGH THE ROUTE, not by calling the store with a hand-built partial.
// That is the whole point of the file. The bug these were written for only
// exists when a key is PRESENT AND UNDEFINED, which is what the route's own
// `{ items: body.items, mobileItems: body.mobileItems }` produces and what a
// literal like `{ mobileItems: [...] }` does not — a first draft of this guard
// called the store directly, and passed with the bug reintroduced.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

// Set before the module graph loads, so the stores this route file reaches read
// an empty tree instead of the operator's real config.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bar-config-"));
process.env.STAGE_UTILITY_DATA = DIR;

const { displaySettingsRoutes } = await import("./routes/display-settings-routes.js");
const { callRoute } = await import("./routes/route-harness.js");
const { barConfigStore } = await import("./bar-config-store.js");

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const save = (body: unknown) =>
  callRoute(displaySettingsRoutes, "/api/bar-items", { method: "POST", body: body as never });

const saved = () => barConfigStore.get();

describe("the context bar's two saved orders", () => {
  test("an unconfigured install has no phone set, which means it follows the desktop bar", async () => {
    // Stamped with the current schema even though there was nothing to migrate.
    // Leaving a fresh install unstamped is what would make the FIRST bar it
    // saves — one that may deliberately carry `plan` with no service type —
    // look like a pre-split config on the next start. See
    // bar-config-migration.test.ts for the rest of that argument.
    assert.equal(await barConfigStore.init(), null);
    assert.deepEqual(saved(), { items: [], mobileItems: [], schema: 1 });
  });

  test("THE GUARD: saving only the phone's set leaves the desktop bar alone", async () => {
    // THE BUG, found in a browser against a real server. `set` merged with
    // `{ ...cache, ...next }`, and the route builds its argument with BOTH keys
    // always present — so a body carrying only `mobileItems` handed the store an
    // `items: undefined`, spread overwrote the kept list with it, and normalising
    // turned that into []. One operator arranging their phone's strip wiped the
    // desktop bar for everybody.
    //
    // No type could have caught it: `Partial<T>` cannot tell "absent" from
    // "present and undefined".
    await save({ items: ["clock", "plan", "spacer", "live-timer"] });
    await save({ mobileItems: ["live-timer", "spacer"] });

    assert.deepEqual(
      saved().items,
      ["clock", "plan", "spacer", "live-timer"],
      "saving the phone's set wiped the desktop bar",
    );
    assert.deepEqual(saved().mobileItems, ["live-timer", "spacer"]);
    // And it reached the disk that way, not only the cache — the failure this
    // guards reads as saved until the next restart otherwise.
    const onDisk = JSON.parse(fs.readFileSync(path.join(DIR, "bar-config.json"), "utf8"));
    assert.deepEqual(onDisk.items, ["clock", "plan", "spacer", "live-timer"]);
  });

  test("THE GUARD, mirrored: saving the desktop bar leaves the phone's set alone", async () => {
    // Not symmetric by construction — each list is merged on its own line — so
    // each direction is its own guard.
    await save({ items: ["plan", "spacer", "recording"] });

    assert.deepEqual(
      saved().mobileItems,
      ["live-timer", "spacer"],
      "saving the desktop bar wiped the phone's set",
    );
    assert.deepEqual(saved().items, ["plan", "spacer", "recording"]);
  });

  test("an explicit empty phone set hands the phone back to the desktop bar", async () => {
    // NOT the same as omitting it, and the difference is load-bearing: `[]` means
    // "follow the desktop bar", so it has to be writable or the configurator's
    // way out of a fork would silently do nothing.
    await save({ mobileItems: [] });
    assert.deepEqual(saved().mobileItems, []);
    assert.deepEqual(saved().items, ["plan", "spacer", "recording"]);
  });

  test("a body naming neither list is refused", async () => {
    const out = await save({});
    assert.equal(out.status, 400);
  });

  test("a list that is not a list of strings is still refused", async () => {
    // Both lists became optional in the same change that added the second one.
    // "Optional" must not have quietly become "unvalidated" — this is the LAN-
    // facing surface.
    for (const body of [{ items: "clock" }, { items: [1, 2] }, { mobileItems: "clock" }, { mobileItems: [null] }]) {
      const out = await save(body);
      assert.equal(out.status, 400, `accepted ${JSON.stringify(body)}`);
    }
  });
});
