import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { VideoFeed, VideoSourceKind } from "../../types/video.js";

// Before any store is constructed: every import below builds its stores
// against this directory, never the default data folder.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-service-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { mergedFeedPatch, videoService, SECRET_SLOT } = await import("./video-service.js");
const { secretsStore } = await import("../secrets.js");
const { configSnapshot } = await import("../config-snapshot.js");

/** Offers every kind for the duration of `fn`: this build offers only embed
 *  and external, and a password only exists for pull. */
async function withAllKinds<T>(fn: () => Promise<T>): Promise<T> {
  const svc = videoService as unknown as { allowedKinds: () => ReadonlySet<VideoSourceKind> };
  svc.allowedKinds = () => new Set<VideoSourceKind>(["pull", "push", "embed", "external"]);
  try {
    return await fn();
  } finally {
    delete (svc as { allowedKinds?: unknown }).allowedKinds;
  }
}

test("a config snapshot never carries a feed's password", async () => {
  const password = "correct-horse-battery-staple";
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Lobby cam", source: { kind: "pull", url: "rtsp://192.0.2.10:8554/s", username: "admin" }, password }),
  );
  assert.ok(made.ok, "expected the pull feed to be added");
  const id = (made as { feed: { id: string } }).feed.id;
  assert.equal((await secretsStore.getSecrets(SECRET_SLOT(id))).password, password, "the seed never reached the secrets store");

  const snapshot = await configSnapshot.build();
  const serialized = JSON.stringify(snapshot);
  assert.ok(serialized.includes(`"${id}"`), "the snapshot must carry the feed itself, or this proves nothing");
  assert.equal(serialized.includes(password), false, "a feed password reached a config snapshot");
});

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
