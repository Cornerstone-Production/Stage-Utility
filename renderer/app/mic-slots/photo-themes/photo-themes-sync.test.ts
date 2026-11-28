// readFrame is the whole policy of when the Mic slots page reads the themes again.
// The rendered half of this (the GETs actually going out) is use-photo-themes.test.tsx.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PhotoThemesChanged } from "@main/types/photo-themes";

import { readFrame } from "./photo-themes-sync.js";

const frame = (seq: number, epoch = "e1"): PhotoThemesChanged => ({
  epoch,
  seq,
  running: 0,
  queued: 0,
  active: [],
  connection: { method: "api-key", hint: "sk-…3f2a", state: "connected", reason: null, checkedAt: null },
});

describe("readFrame", () => {
  test("a replayed frame reads nothing: it is the cache from before this page read", () => {
    assert.deepEqual(readFrame(null, frame(5), true), { reread: false });
    assert.deepEqual(readFrame(frame(5), frame(9), true), { reread: false });
  });
  test("the first live frame, with nothing to compare against, reads", () => {
    assert.deepEqual(readFrame(null, frame(5), false), { reread: true, why: "first" });
  });
  test("the next frame reads: a finished edit is only ever a new seq", () => {
    assert.deepEqual(readFrame(frame(5), frame(6), false), { reread: true, why: "next" });
  });
  test("the same seq again reads nothing", () => {
    assert.deepEqual(readFrame(frame(5), frame(5), false), { reread: false });
  });
  test("a gap is a missed frame", () => {
    assert.deepEqual(readFrame(frame(5), frame(8), false), { reread: true, why: "missed" });
  });
  test("a new epoch is a restart, whatever the seq", () => {
    assert.deepEqual(readFrame(frame(5), frame(1, "e2"), false), { reread: true, why: "restart" });
    assert.deepEqual(readFrame(frame(5), frame(6, "e2"), false), { reread: true, why: "restart" });
    // A restarted server's first frame can repeat the last seq the page saw: still a restart, not "nothing new".
    assert.deepEqual(readFrame(frame(5), frame(5, "e2"), false), { reread: true, why: "restart" });
  });
});
