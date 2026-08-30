import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readinessChecks, outstanding, splitByPresence } from "./readiness.js";

const ready = {
  pcoConfigured: true,
  planId: "p1",
  planTitle: "Philippians 4:13",
  serviceTypeName: "Weekend",
  views: [{ id: "v1" }, { id: "v2" }],
  outputs: [{ id: "d1", name: "Mic board", viewId: "v1" }],
} as unknown as StageState;

describe("readiness", () => {
  test("a fully configured machine has nothing outstanding", () => {
    const checks = readinessChecks(ready, ["d1"]);
    assert.deepEqual(outstanding(checks).map((c) => c.id), []);
  });

  test("every failing check says where to fix it", () => {
    // A check that only reports "not ready" leaves the operator hunting, which
    // is most of the work on a dense page.
    const checks = readinessChecks({ ...ready, pcoConfigured: false } as StageState, ["d1"]);
    for (const c of outstanding(checks)) {
      assert.ok(c.route, `${c.id} fails but does not say where to go`);
    }
  });

  test("a screen with no view assigned is not ready, and is named", () => {
    const checks = readinessChecks(
      { ...ready, outputs: [{ id: "d1", name: "Lobby", viewId: null }] } as unknown as StageState,
      ["d1"],
    );
    const c = checks.find((x) => x.id === "assigned")!;
    assert.equal(c.ok, false);
    // Naming it is the difference between a warning and something actionable.
    assert.match(c.detail, /Lobby/);
  });

  test("an offline screen is not ready, and is named", () => {
    const checks = readinessChecks(ready, []);
    const c = checks.find((x) => x.id === "online")!;
    assert.equal(c.ok, false);
    assert.match(c.detail, /Mic board/);
  });

  test("the shipped default view does not count as having made one", () => {
    // A fresh install ships one View, so "are there any views?" is true before
    // the operator has done anything - the check would arrive pre-ticked and
    // teach nothing. Getting Started measures the same way.
    const checks = readinessChecks({ ...ready, views: [{ id: "v1" }] } as unknown as StageState, ["d1"]);
    assert.equal(checks.find((x) => x.id === "views")?.ok, false);
  });

  test("Home does not count as a view the operator made", () => {
    // Home is seeded on EVERY install, so counting it ticks this check on a
    // fresh box - the same pre-ticked failure as the shipped default above,
    // reintroduced the moment Home became a view. It also inflated the count
    // beside it by one forever.
    const checks = readinessChecks(
      { ...ready, views: [{ id: "v1" }, { id: "home" }] } as unknown as StageState,
      ["d1"],
    );
    const c = checks.find((x) => x.id === "views")!;
    assert.equal(c.ok, false, "Home was counted as a view of the operator's own");
    assert.doesNotMatch(c.detail, /2 views/, "Home was counted in the number shown");
  });

  test("a fresh install degrades instead of throwing", () => {
    // No PCO, no plan, no outputs, no views. This is the ONLY state where the
    // readiness list is the main thing on the page, so it must not blow up.
    const fresh = {
      pcoConfigured: false,
      planId: null,
      planTitle: null,
      serviceTypeName: null,
      views: [],
      outputs: [],
    } as unknown as StageState;
    const checks = readinessChecks(fresh, []);
    assert.equal(checks.length, 5);
    assert.equal(outstanding(checks).length, 5);
    for (const c of checks) assert.ok(c.detail.length > 0, `${c.id} has no detail`);
  });

  test("tolerates absent views/outputs arrays", () => {
    // StageState is server-shaped; an older or partial payload must not take
    // out the home page.
    const partial = { pcoConfigured: true, planId: "p1", planTitle: "x" } as unknown as StageState;
    assert.doesNotThrow(() => readinessChecks(partial, []));
  });

  test("a routed screen with no heartbeat is NOT online", () => {
    // The check read the routed set until Aug 2026, which made "all connected"
    // true of a room with every screen switched off. `d1` is routed to `v1` and
    // nothing has reported in.
    const checks = readinessChecks(ready, []);
    const online = checks.find((c) => c.id === "online")!;
    assert.equal(online.ok, false, "a screen nobody has opened counted as online");
    assert.match(online.detail, /Mic board not connected/);
  });

  test("ids are unique and every check has a label", () => {
    const checks = readinessChecks(ready, ["d1"]);
    assert.equal(new Set(checks.map((c) => c.id)).size, checks.length);
    for (const c of checks) assert.ok(c.label.length > 0, `${c.id} has no label`);
  });
});

describe("splitByPresence", () => {
  const outputs = [
    { id: "d1", name: "Left" },
    { id: "d2", name: "Right" },
  ] as unknown as Output[];

  test("an id that is not a screen is not counted as one", () => {
    // Presence is not a subset of the screens that exist: a page left open on a
    // deleted screen keeps heartbeating. Counting the raw set showed Home
    // "3/2 connected" on a real server.
    const { online, offline } = splitByPresence(outputs, ["d1", "ghost"]);
    assert.deepEqual(online.map((o) => o.id), ["d1"]);
    assert.deepEqual(offline.map((o) => o.id), ["d2"]);
  });

  test("a screen nobody has ever opened is offline, not absent", () => {
    // It appears in no presence set at all, so it can only be found from the
    // screens themselves.
    const { online, offline } = splitByPresence(outputs, []);
    assert.deepEqual(online, []);
    assert.deepEqual(offline.map((o) => o.id), ["d1", "d2"]);
  });
});
