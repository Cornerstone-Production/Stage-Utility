// Upgrading a bar that was saved when "Service type and plan" was one item.
//
// ITS OWN FILE, and that is the whole design of the test rather than tidiness.
// The migration runs exactly once, inside `barConfigStore.init()`, off a file
// that has to be on disk BEFORE the module graph is imported — DataStore caches
// what it read, so a legacy file written after the first load would never be
// seen. bar-config-store.test.ts already loads the store against an empty
// directory in its first line of work, so it cannot also be the file that tests
// a pre-existing config. node's runner gives each file its own process, which is
// what makes two temp directories and two first loads possible at all.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bar-migration-"));
process.env.STAGE_UTILITY_DATA = DIR;

const FILE = path.join(DIR, "bar-config.json");

/** A bar-config.json exactly as a build before the split wrote one: two lists,
 *  no schema stamp, and `plan` standing for BOTH readings. */
fs.writeFileSync(
  FILE,
  JSON.stringify({
    items: ["clock", "plan", "spacer", "current-item", "live-timer"],
    mobileItems: ["plan", "spacer", "live-timer"],
  }),
);

const { barConfigStore, splitServiceType } = await import("./bar-config-store.js");

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const onDisk = () => JSON.parse(fs.readFileSync(FILE, "utf8"));

describe("a bar saved before the service type was its own item", () => {
  test("THE GUARD: it goes on showing both readings, in the order it showed them", async () => {
    // The upgrade story. `plan` used to draw the service-type name and then the
    // plan title; it draws the title alone now. Left as it was, every operator
    // with a configured bar would have lost the service type on the release that
    // let them place it — a reading gone, with nothing said.
    const err = await barConfigStore.init();
    assert.equal(err, null, `the migration could not be saved: ${err?.message}`);
    assert.deepEqual(barConfigStore.get().items, [
      "clock",
      "service-type",
      "plan",
      "spacer",
      "current-item",
      "live-timer",
    ]);
  });

  test("the phone's own set is migrated too, not only the desktop one", async () => {
    // A phone set is a second list in the same file and holds the same ids. It
    // was easy to migrate one and forget the other; that would take the service
    // type off exactly the strip an operator curated by hand.
    assert.deepEqual(barConfigStore.get().mobileItems, ["service-type", "plan", "spacer", "live-timer"]);
  });

  test("and it reached the disk, stamped, not only the cache", async () => {
    // The stamp is the whole idempotency argument. A rewrite that lives only in
    // memory would run again on the next start — and by then the operator may
    // have removed the item it re-inserts.
    const saved = onDisk();
    assert.deepEqual(saved.items, [
      "clock",
      "service-type",
      "plan",
      "spacer",
      "current-item",
      "live-timer",
    ]);
    assert.equal(typeof saved.schema, "number", "the migrated file carries no schema stamp");
  });

  test("THE GUARD: a second load does not insert it again", async () => {
    // The classic failure in this repo: a migration that is a function of the
    // contents rather than of a stamp, so it fires every time it sees what it
    // already wrote. Two loads must be the same bar as one.
    const once = barConfigStore.get().items.slice();
    await barConfigStore.init();
    assert.deepEqual(barConfigStore.get().items, once, "the second load inserted a second service type");
    assert.deepEqual(onDisk().items, once);
  });

  test("saving a bar re-stamps it, so an edit is never re-migrated", async () => {
    // THE case the stamp exists for, and the reason this cannot be done on read.
    // An operator who drags the service type off a migrated bar saves a list
    // naming `plan` alone — indistinguishable, by contents, from a bar that was
    // never migrated. Without the stamp travelling with the save, the next start
    // would put the item straight back and the removal would look broken.
    await barConfigStore.set({ items: ["plan", "spacer", "live-timer"] });
    assert.equal(onDisk().schema, 1, "a saved bar lost its schema stamp");
    assert.deepEqual(onDisk().items, ["plan", "spacer", "live-timer"]);
  });
});

describe("the rewrite itself", () => {
  test("puts the service type in front of every plan item", () => {
    assert.deepEqual(splitServiceType(["plan", "spacer", "plan"]), [
      "service-type",
      "plan",
      "spacer",
      "service-type",
      "plan",
    ]);
  });

  test("leaves a bar with no plan item alone", () => {
    assert.deepEqual(splitServiceType(["clock", "spacer", "recording"]), [
      "clock",
      "spacer",
      "recording",
    ]);
    assert.deepEqual(splitServiceType([]), []);
  });

  test("THE GUARD: running it twice is the same as running it once", () => {
    // The second half of the idempotency argument, independent of the stamp. The
    // stamp stops the rewrite re-running after a deliberate removal; this stops a
    // DOUBLE INSERT if the stamp is ever lost — a hand-edited file, or a config
    // snapshot restored from a build somewhere in between.
    const legacy = ["clock", "plan", "spacer", "plan", "live-timer"];
    const once = splitServiceType(legacy);
    assert.deepEqual(splitServiceType(once), once, "a second pass inserted a second service type");
  });

  test("and a bar that already carries the pair comes back unchanged", () => {
    const already = ["service-type", "plan", "spacer", "live-timer"];
    assert.deepEqual(splitServiceType(already), already);
  });
});
