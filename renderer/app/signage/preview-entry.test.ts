// The playlist editor's preview, and the arithmetic that made it unusable.
//
// Reported as "changing the duration causes it to start flipping through the
// media". The preview entry was anchored at epoch 0, so the player positioned it
// at `Date.now() % cycleMs`. The wall clock modulo one cycle length has no
// relation to the same clock modulo another, so every press of the duration
// stepper threw the preview onto an unrelated item — and holding the stepper
// flipped through the whole playlist.
//
// Anchored at the moment the playlist was opened, elapsed time starts near zero
// and the same edit only re-times the cycle.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignagePlaylist } from "@main/types/signage";
import type { ResolvedItem } from "@main/services/signage-playlist-items";

import { itemAt } from "../../main/signage-cycle";
import { toHorizonPlaylist } from "./preview-entry";

/** A real Date.now(). The size of this number IS the bug. */
const OPENED = 1_787_446_049_919;

const playlist: SignagePlaylist = {
  id: "pl-1",
  name: "Foyer",
  items: [{ mediaId: "m1" }, { mediaId: "m2" }, { mediaId: "m3" }],
  defaultDurationMs: 8000,
  fit: "contain",
  transition: { kind: "cut", ms: 0 },
  createdAt: "",
};

const resolved = (durationMs: number): ResolvedItem[] =>
  ["m1", "m2", "m3"].map((mediaId) => ({
    mediaId,
    media: {
      id: mediaId,
      file: `${mediaId.padEnd(16, "0")}.png`,
      name: mediaId,
      mime: "image/png",
      bytes: 1,
      w: 1920,
      h: 1080,
      createdAt: "",
    },
    durationMs,
    fit: "contain" as const,
    transition: { kind: "cut" as const, ms: 0 },
  }));

/** Which item the player would draw, through the real preview entry. */
function shownItem(durationMs: number, startedAt: number, nowMs: number): number | null {
  const entry = toHorizonPlaylist(playlist, resolved(durationMs), startedAt);
  const at = itemAt(entry.playlist!.items, nowMs - entry.playlist!.startedAt);
  return at?.index ?? null;
}

describe("the editor preview, on a clock that starts at zero", () => {
  // What the section now feeds it: startedAt 0, and a `now` that is
  // elapsed-since-opened (useElapsed) rather than Date.now().
  const shown = (durationMs: number, elapsedMs: number) => shownItem(durationMs, 0, elapsedMs);

  test("stays on the item being edited when its duration changes", () => {
    // Two seconds in. Stepping 8s to 9s must not move which graphic is on
    // screen — that is the operator watching the thing they are adjusting.
    assert.equal(shown(8000, 2000), 0);
    assert.equal(shown(9000, 2000), 0, "the preview jumped off the item being edited");
  });

  test("and holding the stepper does not walk the playlist", () => {
    // Every second from 8s to 20s, which is what holding the chevron produces.
    const seen = new Set<number | null>();
    for (let ms = 8000; ms <= 20_000; ms += 1000) seen.add(shown(ms, 2000));
    assert.deepEqual([...seen], [0], `the preview visited items ${[...seen].join(", ")}`);
  });

  test("still advances on its own, which is what makes it a preview", () => {
    // The fix must not have frozen it: it is a running preview, not a still.
    assert.equal(shown(8000, 2000), 0);
    assert.equal(shown(8000, 10_000), 1);
    assert.equal(shown(8000, 18_000), 2);
    assert.equal(shown(8000, 26_000), 0, "the cycle did not wrap");
  });

  test("the wall clock is what made it flip, and is no longer used", () => {
    // The counterfactual, kept so the reason survives. Fed Date.now(), the same
    // one-second edit lands on a different graphic — which IS the bug report.
    const before = shownItem(8000, 0, OPENED);
    const after = shownItem(9000, 0, OPENED);
    assert.notEqual(before, after, "the wall clock no longer reproduces the bug — re-derive this");
  });

  test("startedAt is honoured, so a real screen can still be fed the server's", () => {
    // A wall keeps the server's startedAt, which is what holds two screens in
    // step. The preview passing 0 must not have hard-coded that.
    const entry = toHorizonPlaylist(playlist, resolved(8000), OPENED);
    assert.equal(entry.playlist?.startedAt, OPENED);
    assert.equal(shownItem(8000, OPENED, OPENED + 10_000), 1);
  });
});
