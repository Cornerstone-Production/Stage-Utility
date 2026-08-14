import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { QUERY_KEYS } from "./queries.js";

// These keys are not cosmetic. 43 handlers and four SSE listeners write results
// back with `queryClient.setQueryData(<key>, next)`. If a key here stops
// matching the one a handler writes, every write lands in a cache entry nothing
// reads: no error, no failing request, just a UI that quietly stops reflecting
// reality. So the exact strings are asserted, not just their uniqueness.
describe("shared query keys", () => {
  test("match the strings handlers and SSE listeners write to", () => {
    assert.deepEqual(QUERY_KEYS.stageState, ["stage:getState"]);
    assert.deepEqual(QUERY_KEYS.serviceTypes, ["stage:listServiceTypes"]);
    assert.deepEqual(QUERY_KEYS.wirelessChannels, ["wireless:listChannels"]);
    assert.deepEqual(QUERY_KEYS.layoutTemplates, ["layoutTemplates:list"]);
    assert.deepEqual(QUERY_KEYS.slotPresets, ["presets:list"]);
    assert.deepEqual(QUERY_KEYS.updateStatus, ["update:status"]);
  });

  test("the plans key varies by service type", () => {
    // A single flat "plans" key would serve one service type's plans for
    // another, which reads as the wrong week rather than as an error.
    assert.deepEqual(QUERY_KEYS.plans("st1"), ["stage:listPlans", "st1"]);
    assert.notDeepEqual(QUERY_KEYS.plans("a"), QUERY_KEYS.plans("b"));
  });

  test("the plans key's prefix supports partial invalidation", () => {
    // Handlers call invalidateQueries({ queryKey: ["stage:listPlans"] }) with no
    // service type, relying on React Query's prefix matching to clear every
    // variant. That only works if the id is a LATER element, never baked into
    // the first one.
    assert.equal(QUERY_KEYS.plans("st1")[0], "stage:listPlans");
    assert.equal(QUERY_KEYS.teamPositions("st1")[0], "stage:listTeamPositions");
  });

  test("every key is unique", () => {
    const resolved = Object.values(QUERY_KEYS).map((k) =>
      JSON.stringify(typeof k === "function" ? k("x") : k),
    );
    assert.equal(new Set(resolved).size, resolved.length, "duplicate query key");
  });

  test("every key is an array", () => {
    for (const [name, k] of Object.entries(QUERY_KEYS)) {
      const resolved = typeof k === "function" ? k("x") : k;
      assert.ok(Array.isArray(resolved), `${name} must be an array key`);
    }
  });
});
