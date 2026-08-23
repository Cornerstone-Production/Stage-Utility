// The elapsed clock on a Resi stream must time the BROADCAST, not us.
//
// Resi's encoder status carries a state and no start time — the published Go
// Live API cannot answer this at all, which is why resi-service rides an
// undocumented one — so the only start we can derive is the moment we watched it
// change. The old code took any first sighting as the start, so configuring the
// integration during a service put 0:00 on the wall over a broadcast forty
// minutes old, and it climbed from there looking entirely plausible.
//
// This drives the real `startedFor` on the real service against the real store,
// because the bug lives in the handover between them: a pure test of either
// half passes.

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-resi-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { resiService } = await import("./resi-service.js");
const { streamStartStore } = await import("./stream-start-store.js");

after(async () => {
  // The store's save is fire-and-forget by design — a poll tick must not block
  // on disk — so a write can still be in flight here. Let the queue drain
  // before removing the directory under it: without this, rmdir raced the
  // write and each side reported the other's mess (ENOTEMPTY here, ENOENT from
  // the store's own error handler).
  await new Promise((r) => setTimeout(r, 100));
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** The private method under test, and the private flag that gates it. */
type Inner = {
  startedFor(live: { uuid: string; status?: string | null }[]): string | null;
  sawOffAir: boolean;
};
const inner = resiService as unknown as Inner;

const LIVE = [{ uuid: "enc-1", status: "started" }];
const NONE: { uuid: string; status?: string | null }[] = [];

beforeEach(() => {
  streamStartStore._reset();
  inner.sawOffAir = false;
});

describe("a stream we did not see start", () => {
  test("has no start time, rather than one measured from now", () => {
    // The reported case exactly: the integration is configured mid-service and
    // its very first poll finds the encoder already streaming.
    assert.equal(
      inner.startedFor(LIVE),
      null,
      "claimed a start it cannot know — the wall would count up from 0:00 over an hour-old stream",
    );
  });

  test("and does not quietly acquire one on the next poll either", () => {
    inner.startedFor(LIVE);
    assert.equal(inner.startedFor(LIVE), null, "the second poll invented what the first refused to");
  });

  test("nor does it persist one for the next restart to believe", () => {
    inner.startedFor(LIVE);
    assert.equal(streamStartStore.known("resi"), null);
  });
});

describe("a stream we watched begin", () => {
  test("starts its clock at the moment it went live", () => {
    const before = Date.now();
    inner.startedFor(NONE); // reachable, off air — this is the sighting that counts
    const started = inner.startedFor(LIVE);
    assert.ok(started, "watched it go live and still reported no start");
    const t = Date.parse(started);
    assert.ok(t >= before && t <= Date.now(), `start ${started} is not the moment of the transition`);
  });

  test("and holds it steady while the stream runs", () => {
    inner.startedFor(NONE);
    const first = inner.startedFor(LIVE);
    assert.equal(inner.startedFor(LIVE), first, "the clock restarted mid-stream");
  });

  test("which survives a restart, since that is when somebody is watching", () => {
    inner.startedFor(NONE);
    const first = inner.startedFor(LIVE);
    // A restart loses the in-memory sighting but not the persisted start.
    inner.sawOffAir = false;
    assert.equal(inner.startedFor(LIVE), first, "a restart mid-service reset the number on the wall");
  });

  test("and is forgotten when the stream ends, so the next one times itself", () => {
    inner.startedFor(NONE);
    const first = inner.startedFor(LIVE);
    assert.ok(first, "watched the first stream go live and still got no start");
    inner.startedFor(NONE);
    assert.equal(streamStartStore.known("resi"), null, "the ended stream's start outlived it");
    const second = inner.startedFor(LIVE);
    assert.ok(second, "the second stream got no start despite being watched from off air");
    // Not `notEqual`: two starts a few microseconds apart stamp the same
    // millisecond, so that assertion failed on correct code. The claim that
    // matters is that the second start is timed fresh rather than inherited,
    // and the cleared store above is what actually proves it.
    assert.ok(Date.parse(second) >= Date.parse(first), "the second stream's clock predates it");
  });
});

describe("a start time Resi itself reports", () => {
  test("wins over anything we observed", () => {
    // It has never been seen to send one. If it ever does, it is the truth and
    // our own sighting is a guess — so this must not need a witnessed
    // transition to be believed.
    const real = "2026-08-23T14:00:00.000Z";
    assert.equal(inner.startedFor([{ uuid: "enc-1", status: "started", startedAt: real }] as never), real);
    assert.equal(streamStartStore.known("resi"), real, "a reported start must persist like an observed one");
  });
});
