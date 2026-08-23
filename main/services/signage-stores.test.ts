// Which half of a backup each signage store lands in.
//
// The classification is a constructor argument so it cannot be forgotten, but
// nothing type-checks whether the choice is RIGHT. This is where that is pinned.
//
// Overrides are the interesting one. A take-over must survive a server restart —
// an announcement that vanished because the box rebooted is a real failure — but
// restoring a two-week-old snapshot must never put a forgotten announcement back
// on a wall. That makes it runtime: persisted, not backed up.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { allStores } from "./stores.js";

const find = (f: string) => allStores().find((s) => s.filename === f);

describe("how signage stores are classified", () => {
  test("media, playlists, groups and schedules are the operator's work", () => {
    for (const f of [
      "signage-media.json",
      "signage-playlists.json",
      "signage-published.json",
      "signage-groups.json",
      "signage-schedules.json",
    ]) {
      assert.equal(find(f)?.classification, "config", `${f} is not carried by a backup`);
    }
  });

  test("overrides are runtime, so a stale backup cannot re-announce", () => {
    assert.equal(find("signage-overrides.json")?.classification, "runtime");
  });

  test("every signage store is actually registered", () => {
    // Registration happens on CONSTRUCTION, which happens on first import. A
    // store nobody imports is silently absent from every backup, which is worse
    // than the hand-maintained list this replaced. stores.ts is what imports
    // them; this fails if one is added to the codebase but not to that file.
    const signage = allStores().filter((s) => s.filename.startsWith("signage-"));
    assert.deepEqual(
      signage.map((s) => s.filename).sort(),
      [
        "signage-groups.json",
        "signage-media.json",
        "signage-overrides.json",
        "signage-playlists.json",
        // What the WALLS are running, as opposed to what the editor holds.
        // Config, and it has to be: restoring a snapshot and finding every wall
        // blank until somebody found a second button would be a bad hour.
        "signage-published.json",
        "signage-schedules.json",
      ],
      "the set of registered signage stores changed",
    );
  });
});

describe("reordering schedules", () => {
  test("puts them in exactly the order given", async () => {
    const { applyScheduleOrder } = await import("./signage-schedules-store.js");
    const all = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ] as never;
    assert.deepEqual(applyScheduleOrder(all, ["c", "a", "b"]).map((s) => s.id), ["c", "a", "b"]);
  });

  test("keeps a schedule the caller never mentioned, rather than dropping it", async () => {
    // The order arrives from a page that loaded a moment ago. If someone else
    // created a schedule in between, a naive reorder would delete it - and this
    // list IS the priority order, so a silently missing schedule stops firing.
    const { applyScheduleOrder } = await import("./signage-schedules-store.js");
    const all = [{ id: "a" }, { id: "b" }, { id: "new" }] as never;
    const out = applyScheduleOrder(all, ["b", "a"]);
    assert.deepEqual(out.map((s) => s.id), ["b", "a", "new"]);
  });

  test("ignores an id that no longer exists", async () => {
    const { applyScheduleOrder } = await import("./signage-schedules-store.js");
    const all = [{ id: "a" }, { id: "b" }] as never;
    assert.deepEqual(applyScheduleOrder(all, ["b", "deleted", "a"]).map((s) => s.id), ["b", "a"]);
  });

  test("a duplicated id does not duplicate the schedule", async () => {
    const { applyScheduleOrder } = await import("./signage-schedules-store.js");
    const all = [{ id: "a" }, { id: "b" }] as never;
    assert.deepEqual(applyScheduleOrder(all, ["a", "a", "b"]).map((s) => s.id), ["a", "b"]);
  });
});

