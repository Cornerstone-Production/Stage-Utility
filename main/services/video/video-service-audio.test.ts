import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Before any store is constructed: every import below builds its stores against
// this directory, never the default data folder.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-audio-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { videoService } = await import("./video-service.js");
const { loadFeedsFile } = await import("./feed-store.js");

const PULL = { kind: "pull", url: "rtsp://192.0.2.10/s", username: "" };

async function stored(id: string) {
  const f = (await loadFeedsFile()).feeds.find((x) => x.id === id);
  assert.ok(f, "the feed is not in the store");
  return f;
}

test("a feed saved with audio settings keeps them, and an edit that leaves them out leaves them alone", async () => {
  const made = await videoService.addFeed({ name: "Aud", source: PULL, audioConversion: "always", audioSourceUrl: "http://192.0.2.28/0.ts" });
  assert.ok(made.ok);
  const id = made.feed.id;
  assert.deepEqual(
    { c: (await stored(id)).audioConversion, u: (await stored(id)).audioSourceUrl },
    { c: "always", u: "http://192.0.2.28/0.ts" },
  );

  const renamed = await videoService.updateFeed(id, { name: "Aud 2" });
  assert.ok(renamed.ok);
  assert.equal((await stored(id)).audioConversion, "always", "a name-only edit lost the setting");
  assert.equal((await stored(id)).audioSourceUrl, "http://192.0.2.28/0.ts", "a name-only edit lost the address");

  const cleared = await videoService.updateFeed(id, { audioSourceUrl: "", audioConversion: "auto" });
  assert.ok(cleared.ok);
  const f = await stored(id);
  assert.equal("audioConversion" in f, false, "auto must be stored as absent");
  assert.equal("audioSourceUrl" in f, false, "an empty address must clear it");
  await videoService.removeFeed(id);
});

test("an edit with a bad audio address is refused and changes nothing", async () => {
  const made = await videoService.addFeed({ name: "Aud bad", source: PULL, audioConversion: "off" });
  assert.ok(made.ok);
  const id = made.feed.id;
  const r = await videoService.updateFeed(id, { audioSourceUrl: "http://h/$HOME", audioConversion: "always" });
  assert.equal(r.ok, false);
  assert.equal((await stored(id)).audioConversion, "off");
  await videoService.removeFeed(id);
});

test("the feeds export carries the audio settings and an import brings them back", async () => {
  const made = await videoService.addFeed({ name: "Aud move", source: PULL, audioConversion: "off", audioSourceUrl: "http://192.0.2.28/0.ts" });
  assert.ok(made.ok);
  const id = made.feed.id;
  const exported = await videoService.exportBundle(id, false, false);
  assert.ok(exported.ok);
  const entry = exported.bundle.feeds[0];
  assert.equal(entry.audioConversion, "off");
  assert.equal(entry.audioSourceUrl, "http://192.0.2.28/0.ts");

  // Same feed, settings changed here since: the review shows the difference and the import restores the file's.
  await videoService.updateFeed(id, { audioConversion: "always", audioSourceUrl: "" });
  const preview = await videoService.previewImport(exported.bundle);
  assert.ok(preview.ok);
  const p = preview.preview.feeds[0];
  assert.equal(p.status, "differs");
  assert.deepEqual(p.differences.map((d) => d.field).sort(), ["audioConversion", "audioSourceUrl"]);
  const imported = await videoService.importFeeds({ bundle: exported.bundle, choices: { [id]: "replace" }, expect: { [id]: p.here } });
  assert.ok(imported.ok && imported.report.replaced.length === 1, JSON.stringify(imported));
  assert.equal((await stored(id)).audioConversion, "off");
  assert.equal((await stored(id)).audioSourceUrl, "http://192.0.2.28/0.ts");

  // A file feed with a bad address is invalid, not written.
  const bad = { ...exported.bundle, feeds: [{ ...entry, audioSourceUrl: "http://h/$HOME" }] };
  const badPreview = await videoService.previewImport(bad);
  assert.ok(badPreview.ok);
  assert.equal(badPreview.preview.feeds[0].status, "invalid");
  await videoService.removeFeed(id);
});
