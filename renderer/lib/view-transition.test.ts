// The view transition's update must settle even when the navigation inside it
// is waiting on a person — see the header of view-transition.ts for the console
// that froze because it did not.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { boundedUpdate, VIEW_TRANSITION_UPDATE_CAP_MS } from "./view-transition.js";

describe("the transition's DOM update", () => {
  test("settles within the cap when the navigation inside it never does", { timeout: 2000 }, async () => {
    // A blocker holding the navigation for the user's answer.
    const never = new Promise<void>(() => {});
    const started = Date.now();
    await boundedUpdate(() => never, 50);
    const took = Date.now() - started;
    assert.ok(took < 1000, `the update waited ${took}ms — a transition waiting on a person freezes the page`);
  });

  test("but lets a navigation that lands in time finish first", async () => {
    let settled = false;
    const quick = new Promise<void>((r) => setTimeout(() => { settled = true; r(); }, 10));
    await boundedUpdate(() => quick, 500);
    assert.equal(settled, true, "the update resolved before the navigation committed, so the crossfade would show the old page twice");
  });

  test("a synchronous update settles immediately, and the cap is short", async () => {
    await boundedUpdate(() => undefined, 5000);
    assert.ok(VIEW_TRANSITION_UPDATE_CAP_MS <= 500, `cap is ${VIEW_TRANSITION_UPDATE_CAP_MS}ms; the browser's own abort is ~4s and anything near it is the bug`);
  });
});
