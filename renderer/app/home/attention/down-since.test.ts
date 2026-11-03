import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { trackDownSince } from "./down-since.js";

describe("trackDownSince", () => {
  it("stamps what is newly down, keeps the stamp while it stays down, forgets what came back", () => {
    const a = trackDownSince(new Map(), ["pp"], 100);
    assert.deepEqual([...a], [["pp", 100]]);
    const b = trackDownSince(a, ["pp", "obs"], 200);
    assert.deepEqual([...b], [["pp", 100], ["obs", 200]]);
    const c = trackDownSince(b, ["obs"], 300);
    assert.deepEqual([...c], [["obs", 200]]);
  });

  it("a second outage starts a fresh clock", () => {
    const up = trackDownSince(trackDownSince(new Map(), ["pp"], 100), [], 150);
    assert.deepEqual([...trackDownSince(up, ["pp"], 400)], [["pp", 400]]);
  });

  it("returns the same map when nothing changed, so no render is caused", () => {
    const a = trackDownSince(new Map(), ["pp"], 100);
    assert.equal(trackDownSince(a, ["pp"], 999), a);
  });
});
