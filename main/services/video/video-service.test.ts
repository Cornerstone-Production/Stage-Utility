import { strict as assert } from "node:assert";
import { test } from "node:test";

import { mergedFeedPatch } from "./video-service.js";
import type { VideoFeed } from "../../types/video.js";

// mergedFeedPatch is what updateFeed re-validates a PATCH against. It used to
// be built inline as `{ name, source }`, dropping a body's top-level
// `password` — harmless while only embed/external are offered pre-relay
// (neither kind ever carries one), but silent data loss on a pull feed's
// password change once PR 2 allows that kind. Tested directly against the
// pure merge, rather than through updateFeed with allowedKinds() stubbed to
// include "pull": that would mean exporting VideoService (or subclassing it)
// just to widen a set this build deliberately keeps narrow, and would
// re-exercise parseFeedInput's and secretsStore's own already-tested
// behaviour along the way. This isolates the exact defect — a field the merge
// silently dropped — without any of that.
const EXISTING: VideoFeed = {
  id: "lobby",
  name: "Lobby",
  source: { kind: "embed", player: "youtube-video", ref: "dQw4w9WgXcQ" },
};

test("a PATCH body's password survives the merge onto the existing feed", () => {
  const merged = mergedFeedPatch(EXISTING, { password: "hunter2" });
  assert.equal(merged.password, "hunter2");
  assert.equal(merged.name, EXISTING.name, "name falls back to the existing feed's when the body omits it");
  assert.deepEqual(merged.source, EXISTING.source, "source falls back the same way");
});

test("a name-only PATCH keeps the existing source and carries no password", () => {
  const merged = mergedFeedPatch(EXISTING, { name: "New name" });
  assert.equal(merged.name, "New name");
  assert.deepEqual(merged.source, EXISTING.source);
  assert.equal(merged.password, undefined);
});

test("a body with its own source overrides the existing one, password included", () => {
  const merged = mergedFeedPatch(EXISTING, { source: { kind: "external", url: "http://h/whep" }, password: "pw" });
  assert.deepEqual(merged.source, { kind: "external", url: "http://h/whep" });
  assert.equal(merged.password, "pw");
});

test("a non-object body falls back to the existing feed entirely", () => {
  const merged = mergedFeedPatch(EXISTING, null);
  assert.equal(merged.name, EXISTING.name);
  assert.deepEqual(merged.source, EXISTING.source);
  assert.equal(merged.password, undefined);
});
