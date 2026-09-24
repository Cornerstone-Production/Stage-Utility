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

const { baptismStore, MAX_SESSIONS } = await import("./baptism-store.js");

const session = (n: number): BaptismSession =>
  ({
    id: `bap-${n}`,
    startedAt: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString(),
    finishedAt: null,
    people: [],
  }) as unknown as BaptismSession;

/** Capture console.log lines starting with `prefix`, the same technique
 *  baptism-legacy-restore.test.ts uses — a guard on a log line has to watch
 *  the real call, not trust that the code makes it. Restore with release()
 *  even on assertion failure. */
function captureLog(prefix: string): { lines: string[]; release: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith(prefix)) lines.push(args[0]);
  };
  return {
    lines,
    release: () => {
      console.log = original;
    },
  };
}

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

  it("a restore is never capped, even long past MAX_SESSIONS", async () => {
    // The bug this branch fixes: addSessions ended in `.slice(0, MAX_SESSIONS)`,
    // contradicting its own doc comment ("without a cap") — a restore is the
    // one write an operator would never forgive being silently trimmed.
    await baptismStore.addSessions(Array.from({ length: 2100 }, (_, i) => session(10_000 + i)));
    const n = (await baptismStore.listSessions()).length;
    assert.equal(n, 2100, `a restore evicted sessions instead of keeping every one of them (got ${n})`);
  });

  it("a restore into a store already near the cap keeps every session, old and new", async () => {
    const existing = Array.from({ length: MAX_SESSIONS - 10 }, (_, i) => session(20_000 + i));
    await baptismStore.addSessions(existing);
    assert.equal((await baptismStore.listSessions()).length, MAX_SESSIONS - 10, "precondition: near the cap");

    const incoming = Array.from({ length: 50 }, (_, i) => session(90_000 + i)); // crosses the cap by 40
    const added = await baptismStore.addSessions(incoming);
    const after = await baptismStore.listSessions();

    assert.equal(added, 50);
    assert.equal(
      after.length,
      MAX_SESSIONS + 40,
      "a restore that crossed the cap evicted the excess instead of keeping it",
    );
    for (const s of existing) {
      assert.ok(after.some((a) => a.id === s.id), `lost an existing session (${s.id}) once the cap was crossed`);
    }
    for (const s of incoming) {
      assert.ok(after.some((a) => a.id === s.id), `lost a restored session (${s.id})`);
    }
  });

  it("a live append at the cap evicts exactly one session, and logs it", async () => {
    await baptismStore.addSessions(Array.from({ length: MAX_SESSIONS }, (_, i) => session(30_000 + i)));
    assert.equal((await baptismStore.listSessions()).length, MAX_SESSIONS, "precondition: exactly at the cap");

    const cap = captureLog("[baptism] a live append evicted");
    try {
      await baptismStore.addSession(session(39_999));
    } finally {
      cap.release();
    }

    const after = await baptismStore.listSessions();
    assert.equal(after.length, MAX_SESSIONS, "an append at the cap must still hold growth at MAX_SESSIONS");
    assert.ok(after.some((s) => s.id === "bap-39999"), "the new session must be in the store");
    assert.deepEqual(cap.lines, ["[baptism] a live append evicted 1 session(s) to stay at the cap"]);
  });

  it("a live append after an over-cap restore evicts one session, not the whole excess", async () => {
    // The failure this whole fix exists to prevent: a restore that legitimately
    // left the store over the cap must not have its excess mass-deleted by the
    // very next live Finish.
    const over = MAX_SESSIONS + 50;
    await baptismStore.addSessions(Array.from({ length: over }, (_, i) => session(40_000 + i)));
    assert.equal((await baptismStore.listSessions()).length, over, "precondition: over the cap after a restore");

    await baptismStore.addSession(session(49_999));

    const after = await baptismStore.listSessions();
    // One evicted, one added — the over-cap size holds, rather than being
    // sliced straight down to MAX_SESSIONS.
    assert.equal(
      after.length,
      over,
      `a single live append evicted more than one session from an over-cap store (now ${after.length}, was ${over})`,
    );
    assert.ok(after.some((s) => s.id === "bap-49999"), "the new session must be in the store");
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

describe("mergeRebuilt refuses two sessions sharing one id", () => {
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

describe("mergeRebuilt — 'no write at all' for an intact session, guarded not just claimed", () => {
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

// Unlike addSession/addSessions, mergeRebuilt must NEVER evict an existing
// session to make room for a rebuild — an existing session used to
// be exactly as likely to fall off the cap as anything else, sorted
// newest-first and sliced. A rebuild's job is to reconstruct data the
// operator already has, not delete some of it to fit the rest in.
describe("mergeRebuilt never evicts, even at the cap", () => {
  it("adds only what fits, applies every update, and evicts nothing", async () => {
    const keptId = "bap-cap-unit-kept";
    const updateId = "bap-cap-unit-update";
    const kept = { id: keptId, startedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(), finishedAt: null, people: [] } as unknown as BaptismSession;
    const toUpdate = {
      id: updateId,
      startedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      finishedAt: "2026-01-02T00:00:00.000Z",
      people: [{ testimonyMs: 1, baptizeMs: 1 }],
    } as unknown as BaptismSession;
    await baptismStore.addSession(kept);
    await baptismStore.addSession(toUpdate);

    // Fill every remaining slot — whatever this file's earlier tests left
    // behind — so the store sits exactly at the cap regardless of run order.
    const before = await baptismStore.listSessions();
    const filler = Array.from({ length: Math.max(0, MAX_SESSIONS - before.length) }, (_, i) => session(40_000 + i));
    if (filler.length > 0) await baptismStore.addSessions(filler);
    assert.equal((await baptismStore.listSessions()).length, MAX_SESSIONS, "precondition: the store is at the cap");

    const updatedVersion = { ...toUpdate, finishedAt: "2026-01-02T01:00:00.000Z" };
    const brandNew = {
      id: "bap-cap-unit-new",
      startedAt: new Date(Date.UTC(2026, 0, 3)).toISOString(),
      finishedAt: null,
      people: [],
    } as unknown as BaptismSession;

    try {
      const { full } = await baptismStore.mergeRebuilt([updatedVersion, brandNew]);
      const all = await baptismStore.listSessions();

      assert.equal(full, 1, "the store is already full — the brand-new session must be refused, not evicted for");
      assert.equal(all.length, MAX_SESSIONS, "the store must hold exactly what it held before — an update never changes the count");
      assert.ok(!all.some((s) => s.id === brandNew.id), "the refused session must not be in the store");

      const stillKept = all.find((s) => s.id === keptId);
      assert.deepStrictEqual(stillKept, kept, "an untouched existing session must survive byte-identical — never evicted");

      const nowUpdated = all.find((s) => s.id === updateId);
      assert.equal(nowUpdated?.finishedAt, "2026-01-02T01:00:00.000Z", "the update must still land even though the store is at the cap");
    } finally {
      for (const f of filler) await baptismStore.deleteSession(f.id);
      await baptismStore.deleteSession(keptId);
      await baptismStore.deleteSession(updateId);
    }
  });

  // The save-failure note's own Rebuild offer clears an entry by id, only
  // for a session mergeRebuilt ACTUALLY wrote — never one merely planned. A
  // bare added COUNT cannot say
  // which of several candidates landed, so this proves addedIds names exactly
  // the one the cap let through, in the order offered, and never the update
  // (which was never "added" at all) or the one the cap turned away.
  it("addedIds names exactly the sessions that fit, never an update and never the one the cap turned away", async () => {
    const keptId = "bap-cap-ids-kept";
    const firstNewId = "bap-cap-ids-first-new";
    const secondNewId = "bap-cap-ids-second-new";
    const kept = { id: keptId, startedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(), finishedAt: null, people: [] } as unknown as BaptismSession;
    await baptismStore.addSession(kept);

    // Exactly ONE slot free under the cap.
    const before = await baptismStore.listSessions();
    const filler = Array.from({ length: Math.max(0, MAX_SESSIONS - 1 - before.length) }, (_, i) => session(60_000 + i));
    if (filler.length > 0) await baptismStore.addSessions(filler);
    assert.equal((await baptismStore.listSessions()).length, MAX_SESSIONS - 1, "precondition: exactly one slot free");

    const firstNew = { id: firstNewId, startedAt: new Date(Date.UTC(2026, 0, 4)).toISOString(), finishedAt: null, people: [] } as unknown as BaptismSession;
    const secondNew = { id: secondNewId, startedAt: new Date(Date.UTC(2026, 0, 5)).toISOString(), finishedAt: null, people: [] } as unknown as BaptismSession;
    const updatedKept = { ...kept, finishedAt: "2026-01-01T01:00:00.000Z" };

    try {
      const { added, addedIds, full } = await baptismStore.mergeRebuilt([updatedKept, firstNew, secondNew]);
      assert.equal(full, 1, "only one of the two brand-new sessions fits");
      assert.equal(added, 1, "added must equal addedIds.size, by construction");
      assert.deepEqual(
        [...addedIds],
        [firstNewId],
        "addedIds must name the ONE that actually landed, in the order offered — never the update, never the one the cap turned away",
      );

      const all = await baptismStore.listSessions();
      assert.ok(all.some((s) => s.id === firstNewId), "the first new session must actually be in the store");
      assert.ok(!all.some((s) => s.id === secondNewId), "the second new session must not be in the store");
    } finally {
      for (const f of filler) await baptismStore.deleteSession(f.id);
      await baptismStore.deleteSession(keptId);
      await baptismStore.deleteSession(firstNewId);
      await baptismStore.deleteSession(secondNewId);
    }
  });
});
