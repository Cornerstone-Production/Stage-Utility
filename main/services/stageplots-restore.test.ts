// What a config restore does to published stage plots: the merge of the restored stage plots
// document with the live one it replaces (mergeRestoredStagePlots), one case per rule. The same
// rules driven through the real configSnapshot.apply, the publisher and a fake page are in
// stageplots-restore-drive.test.ts.
//
// THE RULE UNDER ALL OF IT: after a restore, no secret that may be live on a page is unknown to
// the store. Every case ends by checking that every secret either file held is on a venue or
// queued for removal, unless it is another server's (a keep-own-id restore of its config).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mergeRestoredStagePlots } from "./stageplots-doc.js";
import type { PendingRemoval, StagePlotsDoc, VenuePublish } from "../types/stageplots.js";

const ORIGIN = "https://plots.example.workers.dev";
const NOW = "2026-11-12T12:00:00.000Z";
const S = (c: string) => `${c.repeat(42)}E`;

function pub(secret: string, origin = ORIGIN): VenuePublish {
  return { secret, origin, publishedAt: "2026-11-01T12:00:00.000Z", lastError: null, publishedImages: [], unpublishedImages: [] };
}

function doc(publishes: (VenuePublish | null)[], pendingRemovals: PendingRemoval[] = []): StagePlotsDoc {
  return {
    venues: publishes.map((p, i) => ({ id: `v-${i}`, name: `Room ${i}`, kind: "home", notes: "", plotIds: [], defaultPlotId: null, ...(p ? { publish: p } : {}) })),
    backgrounds: [],
    plots: [],
    overrides: [],
    pendingRemovals,
  };
}

const queued = (secret: string, reason: PendingRemoval["reason"] = "regenerated"): PendingRemoval => ({ secret, origin: ORIGIN, since: "2026-11-10T12:00:00.000Z", reason });
const published = (d: StagePlotsDoc) => d.venues.map((v) => v.publish?.secret ?? null);
const pendingSecrets = (d: StagePlotsDoc) => d.pendingRemovals.map((e) => e.secret).sort();

/** Every secret in `sources` is on a venue or queued in `out`. */
function allKnown(out: StagePlotsDoc, ...sources: StagePlotsDoc[]) {
  const known = new Set([...out.venues.flatMap((v) => (v.publish ? [v.publish.secret] : [])), ...out.pendingRemovals.map((e) => e.secret)]);
  for (const d of sources) {
    for (const s of [...d.venues.flatMap((v) => (v.publish ? [v.publish.secret] : [])), ...d.pendingRemovals.map((e) => e.secret)]) {
      assert.ok(known.has(s), "a secret either file held is neither on a venue nor queued");
    }
  }
}

describe("a restore that keeps this server's id (another server's config, or one with no id)", () => {
  test("drops the config's links, which stay with the server they came from, and queues this server's own", () => {
    const live = doc([pub(S("L"))]);
    const restored = doc([pub(S("R"))], [queued(S("Q"))]);
    const r = mergeRestoredStagePlots({ restored, live, mode: "keep-own", now: NOW });
    assert.deepEqual(published(r.doc), [null]);
    assert.deepEqual(pendingSecrets(r.doc), [S("L")], "another server's links were queued, and would be taken down on its page");
    assert.deepEqual([r.unpublished, r.queued], [1, 1]);
    allKnown(r.doc, live);
  });

  test("keeps a link both files hold on a venue: provably this server's, whatever the ids say", () => {
    // A box restoring its own backup with no server id on either side: the ids say "keep own".
    const live = doc([pub(S("A"))]);
    const restored = doc([pub(S("A"))]);
    const r = mergeRestoredStagePlots({ restored, live, mode: "keep-own", now: NOW });
    assert.deepEqual(published(r.doc), [S("A")]);
    assert.deepEqual(pendingSecrets(r.doc), []);
    allKnown(r.doc, live, restored);
  });
});

describe("a restore of this server's own config (the same id)", () => {
  test("a link the backup has and the live file does not is not revived: it comes back unpublished, and is queued", () => {
    // Drive A: regenerated after the backup. Live holds S2 on the venue and S1 waiting (or gone).
    const live = doc([pub(S("2"))]);
    const restored = doc([pub(S("1"))]);
    const r = mergeRestoredStagePlots({ restored, live, mode: "same-id", now: NOW });
    assert.deepEqual(published(r.doc), [null], "the revoked link came back");
    assert.deepEqual(pendingSecrets(r.doc), [S("1"), S("2")].sort());
    allKnown(r.doc, live, restored);
  });

  test("a link published after the backup is queued, not stranded", () => {
    // Drive B.
    const live = doc([pub(S("N"))]);
    const restored = doc([null]);
    const r = mergeRestoredStagePlots({ restored, live, mode: "same-id", now: NOW });
    assert.deepEqual(pendingSecrets(r.doc), [S("N")]);
    assert.equal(r.doc.pendingRemovals[0]!.reason, "restored over");
    allKnown(r.doc, live);
  });

  test("a link the live file only has queued is not brought back to its venue", () => {
    const live = doc([null], [queued(S("1"))]);
    const restored = doc([pub(S("1"))]);
    const r = mergeRestoredStagePlots({ restored, live, mode: "same-id", now: NOW });
    assert.deepEqual(published(r.doc), [null]);
    assert.deepEqual(pendingSecrets(r.doc), [S("1")]);
  });

  test("on a fresh box (no live stage plots, or no venues) the backup's links come back", () => {
    for (const live of [undefined, doc([])]) {
      const restored = doc([pub(S("1"))], [queued(S("Q"))]);
      const r = mergeRestoredStagePlots({ restored, live, mode: "same-id", now: NOW });
      assert.deepEqual(published(r.doc), [S("1")]);
      assert.deepEqual(pendingSecrets(r.doc), [S("Q")]);
    }
  });

  test("a box that unpublished every venue is not a fresh one: an older backup's link is not revived", () => {
    const live = doc([null]);
    const restored = doc([pub(S("1"))]);
    const r = mergeRestoredStagePlots({ restored, live, mode: "same-id", now: NOW });
    assert.deepEqual(published(r.doc), [null]);
    assert.deepEqual(pendingSecrets(r.doc), [S("1")]);
  });

  test("keeps what both files hold, and the backup's own queue", () => {
    const live = doc([pub(S("A")), pub(S("B"))], [queued(S("Q"))]);
    const restored = doc([pub(S("A")), null], [queued(S("P"))]);
    const r = mergeRestoredStagePlots({ restored, live, mode: "same-id", now: NOW });
    assert.deepEqual(published(r.doc), [S("A"), null]);
    assert.deepEqual(pendingSecrets(r.doc), [S("B"), S("P"), S("Q")].sort());
    allKnown(r.doc, live, restored);
  });
});

describe("a restore that takes the config's id (this box replaces that one)", () => {
  test("brings the config's links back, and queues this box's own", () => {
    const live = doc([pub(S("L"))]);
    const restored = doc([pub(S("R"))]);
    const r = mergeRestoredStagePlots({ restored, live, mode: "replace", now: NOW });
    assert.deepEqual(published(r.doc), [S("R")]);
    assert.deepEqual(pendingSecrets(r.doc), [S("L")]);
    allKnown(r.doc, live, restored);
  });
});

describe("a live file that cannot be read", () => {
  // "unknown" is never a fresh install: it may hold a revocation nobody can read, so no restored
  // link comes back published in any mode, and each that is this server's to remove is queued.
  for (const mode of ["same-id", "replace"] as const) {
    test(`revives nothing and queues the restored links (${mode})`, () => {
      const restored = doc([pub(S("A")), null], [queued(S("Q"))]);
      const { doc: out, unpublished } = mergeRestoredStagePlots({ restored, live: "unknown", mode, now: NOW });
      assert.deepEqual(published(out), [null, null]);
      assert.equal(unpublished, 1);
      assert.deepEqual(pendingSecrets(out), [S("A"), S("Q")].sort());
      allKnown(out, restored);
    });
  }

  test("leaves another server's links with it (keep-own)", () => {
    const restored = doc([pub(S("A"))]);
    const { doc: out } = mergeRestoredStagePlots({ restored, live: "unknown", mode: "keep-own", now: NOW });
    assert.deepEqual(published(out), [null]);
    assert.deepEqual(out.pendingRemovals, []);
  });
});
