import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-seen-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { videoSeenStore, loadSeen, lastSeenAt, noteSeen, SEEN_WRITE_INTERVAL_MS } = await import("./seen-store.js");

test("a feed nothing has ever noted reads null", () => {
  assert.equal(lastSeenAt("never-seen"), null);
});

test("noteSeen is readable synchronously, before its own write settles", async () => {
  const write = noteSeen("sync-cam", 1_000);
  // The whole point of the in-memory Map: a caller does not have to await
  // noteSeen() before feedState()'s lastSeenAt input is correct.
  assert.equal(lastSeenAt("sync-cam"), 1_000);
  await write;
});

test("the first note for a feed writes to disk; a second inside the throttle window does not", async () => {
  await noteSeen("throttle-cam", 10_000);
  assert.deepEqual((await videoSeenStore.reload())["throttle-cam"], 10_000);

  await noteSeen("throttle-cam", 10_000 + SEEN_WRITE_INTERVAL_MS - 1);
  assert.deepEqual(
    (await videoSeenStore.reload())["throttle-cam"],
    10_000,
    "a note inside the throttle window must not reach disk yet",
  );
  // The in-memory Map is NOT throttled — only the disk write is.
  assert.equal(lastSeenAt("throttle-cam"), 10_000 + SEEN_WRITE_INTERVAL_MS - 1);
});

test("a note at or past the throttle window writes again", async () => {
  await noteSeen("resumes-cam", 0);
  await noteSeen("resumes-cam", SEEN_WRITE_INTERVAL_MS);
  assert.deepEqual((await videoSeenStore.reload())["resumes-cam"], SEEN_WRITE_INTERVAL_MS);
});

test("the throttle window is per feed — one feed writing does not silence another", async () => {
  await noteSeen("feed-a", 0);
  await noteSeen("feed-b", 0);
  await noteSeen("feed-b", 1); // inside feed-b's own window, suppressed
  await noteSeen("feed-a", SEEN_WRITE_INTERVAL_MS); // past feed-a's own window
  const onDisk = await videoSeenStore.reload();
  assert.deepEqual([onDisk["feed-a"], onDisk["feed-b"]], [SEEN_WRITE_INTERVAL_MS, 0]);
});

test("loadSeen populates the in-memory Map from whatever is already on disk", async () => {
  await videoSeenStore.save({ "restored-cam": 42 });
  assert.equal(lastSeenAt("restored-cam"), null, "not yet loaded");
  await loadSeen();
  assert.equal(lastSeenAt("restored-cam"), 42);
});
