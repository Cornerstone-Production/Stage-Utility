// episode-log.test.ts — what a pair's [video] lines last announced.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { EpisodeLog } from "./episode-log.js";

function recorder() {
  const said: string[] = [];
  return { said, say: { started: () => said.push("started"), ended: () => said.push("ended") } };
}

test("a line when an episode starts and another when it ends, nothing while it holds", () => {
  const log = new EpisodeLog();
  const r = recorder();
  log.note("k", null, r.say);
  log.note("k", 1, r.say);
  log.note("k", 1, r.say);
  log.note("k", 1, r.say);
  log.note("k", null, r.say);
  log.note("k", null, r.say);
  assert.deepEqual(r.said, ["started", "ended"]);
});

test("a new id while an episode is still announced is an end then a start, in that order", () => {
  const log = new EpisodeLog();
  const r = recorder();
  log.note("k", 1, r.say);
  log.note("k", 2, r.say);
  assert.deepEqual(r.said, ["started", "ended", "started"]);
});

test("pairs are independent", () => {
  const log = new EpisodeLog();
  const r = recorder();
  log.note("a", 1, r.say);
  log.note("b", null, r.say);
  assert.deepEqual(r.said, ["started"]);
});

test("prune forgets a pair that left, so its return announces afresh and ends nothing", () => {
  const log = new EpisodeLog();
  const r = recorder();
  log.note("a", 1, r.say);
  log.prune(new Set());
  assert.equal(log.has("a"), false);
  log.note("a", 1, r.say);
  assert.deepEqual(r.said, ["started", "started"]);
  log.prune(new Set(["a"]));
  assert.equal(log.has("a"), true, "a pair still present is kept");
});

test("forgetFeed forgets that feed's pairs on every output and no other", () => {
  const log = new EpisodeLog();
  const r = recorder();
  log.note("out1\u0000cam", 1, r.say);
  log.note("out2\u0000cam", 1, r.say);
  log.note("out1\u0000other", 1, r.say);
  log.forgetFeed("cam");
  assert.deepEqual([log.has("out1\u0000cam"), log.has("out2\u0000cam"), log.has("out1\u0000other")], [false, false, true]);
});
