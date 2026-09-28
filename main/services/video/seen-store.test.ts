import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-seen-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { videoSeenStore, loadSeen, lastSeenAt, noteSeen, flushSeen, forgetSeen, SEEN_WRITE_INTERVAL_MS } = await import(
  "./seen-store.js"
);

/** Casts to the same shape the existing video-service.test.ts uses to fake a
 *  store failure (`secretsStore as unknown as { setSecret: ... }`), so a
 *  rejecting write can be simulated without touching the real filesystem. */
const asFailable = videoSeenStore as unknown as { update: (...a: unknown[]) => Promise<unknown> };

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

test("a write that rejects does not mark the feed written — the next call retries rather than being throttled away", async () => {
  const realUpdate = asFailable.update.bind(videoSeenStore);
  asFailable.update = async () => {
    throw new Error("disk full");
  };
  try {
    await assert.rejects(noteSeen("failing-cam", 0), /disk full/);
  } finally {
    asFailable.update = realUpdate;
  }
  // The in-memory value still advanced (noteSeen()'s whole synchronous-read
  // point), but nothing reached disk, and — the actual bug — the throttle
  // must not have been armed by the failed attempt either.
  assert.equal(lastSeenAt("failing-cam"), 0);
  await noteSeen("failing-cam", 1); // 1 ms later: inside the window IF the failed write had counted
  assert.deepEqual((await videoSeenStore.reload())["failing-cam"], 1, "a retry right after a failed write must not be throttled");
});

test("flushSeen writes the current in-memory value regardless of the throttle", async () => {
  await noteSeen("flush-cam", 0);
  await noteSeen("flush-cam", SEEN_WRITE_INTERVAL_MS - 1); // inside the window, suppressed
  assert.deepEqual((await videoSeenStore.reload())["flush-cam"], 0, "the throttle must still be suppressing this, or the next line proves nothing");

  await flushSeen("flush-cam");
  assert.deepEqual((await videoSeenStore.reload())["flush-cam"], SEEN_WRITE_INTERVAL_MS - 1);
});

test("flushSeen on a feed nothing has ever noted is a no-op", async () => {
  await flushSeen("never-flushed-cam");
  assert.equal((await videoSeenStore.reload())["never-flushed-cam"], undefined);
});

test("forgetSeen clears a feed from memory and disk", async () => {
  await noteSeen("forget-cam", 5);
  assert.equal(lastSeenAt("forget-cam"), 5);
  assert.deepEqual((await videoSeenStore.reload())["forget-cam"], 5);

  await forgetSeen("forget-cam");
  assert.equal(lastSeenAt("forget-cam"), null);
  assert.equal((await videoSeenStore.reload())["forget-cam"], undefined);

  // And the throttle itself is forgotten — a fresh note right away is not
  // "inside the window" of a write that no longer exists.
  await noteSeen("forget-cam", 6);
  assert.deepEqual((await videoSeenStore.reload())["forget-cam"], 6);
});
