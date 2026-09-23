// Importing a data archive used to destroy the operator's own baptism history.
//
// The import looped over addSession, and every call re-applied the live cap of
// 100 — so bringing 45 sessions back onto a box already holding 80 pushed 25 of
// its own past the cap and deleted them from disk. The API reported only what it
// had added, so nothing ever said the rest were gone. importArchive documents
// itself as "merges and never overwrites"; the cap on the callee defeated it.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { BaptismSession } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-store-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismStore } = await import("./baptism-store.js");

const session = (n: number): BaptismSession =>
  ({
    id: `bap-${n}`,
    startedAt: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString(),
    finishedAt: null,
    people: [],
  }) as unknown as BaptismSession;

describe("baptism sessions", () => {
  beforeEach(async () => {
    await baptismStore.addSessions([]); // ensure the store is loaded
    for (const s of await baptismStore.listSessions()) await baptismStore.deleteSession(s.id);
  });

  it("a live append does not truncate a restored history", async () => {
    // The fix that mattered. Importing worked, and then the very next baptism
    // sliced the list back to the old cap of 100 and destroyed 139 of the
    // restored sessions for good — a ceiling small enough to reach in normal use
    // is a data-loss mechanism wearing a cap's clothing.
    await baptismStore.addSessions(Array.from({ length: 240 }, (_, i) => session(i)));
    assert.equal((await baptismStore.listSessions()).length, 240);

    await baptismStore.addSession(session(9999));
    assert.equal(
      (await baptismStore.listSessions()).length,
      241,
      "a single live baptism truncated the restored history",
    );
  });

  it("still bounds growth, so the file cannot grow without limit", async () => {
    await baptismStore.addSessions(Array.from({ length: 2100 }, (_, i) => session(10_000 + i)));
    const n = (await baptismStore.listSessions()).length;
    assert.ok(n <= 2000, `expected a ceiling, got ${n}`);
  });

  it("does NOT evict existing sessions on a restore", async () => {
    // 80 of the operator's own, then a 45-session archive on top.
    for (let i = 0; i < 80; i++) await baptismStore.addSession(session(i));
    const incoming = Array.from({ length: 45 }, (_, i) => session(500 + i));

    const added = await baptismStore.addSessions(incoming);
    const after = await baptismStore.listSessions();

    assert.equal(added, 45);
    assert.equal(after.length, 125, "the operator's own sessions must survive the import");
    for (let i = 0; i < 80; i++) {
      assert.ok(after.some((s) => s.id === `bap-${i}`), `lost the operator's own session bap-${i}`);
    }
  });

  it("is idempotent — re-importing the same archive adds nothing", async () => {
    const incoming = Array.from({ length: 5 }, (_, i) => session(900 + i));
    assert.equal(await baptismStore.addSessions(incoming), 5);
    assert.equal(await baptismStore.addSessions(incoming), 0);
    assert.equal((await baptismStore.listSessions()).length, 5);
  });

  it("keeps the list newest-first after a merge", async () => {
    await baptismStore.addSessions([session(10), session(1), session(5)]);
    const ids = (await baptismStore.listSessions()).map((s) => s.id);
    assert.deepEqual(ids, ["bap-10", "bap-5", "bap-1"]);
  });
});

describe("addSession is idempotent by id", () => {
  beforeEach(async () => {
    await baptismStore.addSessions([]); // ensure the store is loaded
    for (const s of await baptismStore.listSessions()) await baptismStore.deleteSession(s.id);
  });

  it("replaces a session carrying an id already stored", async () => {
    // finish -> undo -> finish re-finalizes the SAME session: `id` is derived
    // from sessionStartedAt, which undo does not change. Prepending a second
    // row makes linkBaptisms count that service's people twice in History.
    // id 777777 falls outside every range the other describes in this file use,
    // so this test does not depend on running after (or before) them.
    const first = { ...session(777_777), people: [{ testimonyMs: 1000, baptizeMs: 500 }] } as BaptismSession;
    const corrected = { ...session(777_777), people: [{ testimonyMs: 9000, baptizeMs: 500 }] } as BaptismSession;

    await baptismStore.addSession(first);
    await baptismStore.addSession(corrected);

    const all = await baptismStore.listSessions();
    const mine = all.filter((s) => s.id === first.id);
    assert.equal(mine.length, 1, "the re-finished session must replace, not duplicate");
    assert.equal(mine[0].people[0].testimonyMs, 9000, "the later write wins");
  });
});

describe("mergeRebuilt refuses two sessions sharing one id (I1)", () => {
  it("throws rather than silently keeping the last of a duplicate pair", async () => {
    const a = { ...session(600), people: [{ testimonyMs: 1, baptizeMs: 1 }] };
    const b = { ...session(600), people: [{ testimonyMs: 2, baptizeMs: 2 }] }; // same id, different content
    await assert.rejects(
      () => baptismStore.mergeRebuilt([a, b]),
      /sharing id/,
      "two sessions with the same id must be refused, not silently collapsed by a Map",
    );
  });
});

/** Reach into the store's own internals to spy on the underlying write — the
 *  same technique history-rebuild-route.test.ts uses on other stores'
 *  `upsert`. `private` is compile-time only; this proves the claim in
 *  mergeRebuilt's own doc comment rather than trusting it. */
function spyOnWrite(): { calls: () => number; restore: () => void } {
  const internals = (baptismStore as unknown as { store: { writeRaw: (data: unknown) => Promise<void> } }).store;
  const original = internals.writeRaw.bind(internals);
  let calls = 0;
  internals.writeRaw = async (data: unknown) => {
    calls += 1;
    return original(data);
  };
  return { calls: () => calls, restore: () => { internals.writeRaw = original; } };
}

describe("mergeRebuilt — 'no write at all' for an intact session, guarded not just claimed (M3)", () => {
  it("does not touch the underlying write when the session already matches exactly", async () => {
    const s = { ...session(700), people: [{ testimonyMs: 5, baptizeMs: 5 }] };
    await baptismStore.addSession(s);
    const spy = spyOnWrite();
    try {
      await baptismStore.mergeRebuilt([{ ...s }]); // a new object, identical content
      assert.equal(spy.calls(), 0, "an already-intact session must not reach the underlying write");
    } finally {
      spy.restore();
    }
  });

  it("does write when the session's content genuinely changed", async () => {
    const s = { ...session(701), people: [{ testimonyMs: 5, baptizeMs: 5 }] };
    await baptismStore.addSession(s);
    const spy = spyOnWrite();
    try {
      await baptismStore.mergeRebuilt([{ ...s, people: [{ testimonyMs: 99, baptizeMs: 99 }] }]);
      assert.equal(spy.calls(), 1, "a real change must still reach the underlying write");
    } finally {
      spy.restore();
    }
  });
});
