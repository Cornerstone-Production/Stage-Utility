// What a display fetches ahead of needing it.
//
// Two failures to avoid, pulling in opposite directions. Fetching nothing means
// a visible pause at each boundary while the next graphic loads. Fetching the
// whole day is gigabytes once video is in a playlist, on a Pi with an SD card.
//
// So: the current window in full, plus enough of the next one to cover the
// boundary itself — under a byte cap that REPORTS what it dropped. Silently
// fetching less is the worst of the three, because the display then looks ready
// and is not.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignageHorizon } from "@main/types/signage";
import { planPrefetch } from "./signage-prefetch.js";

const item = (url: string, bytes: number) => ({
  url,
  mime: "image/png",
  durationMs: 8000,
  fit: "contain" as const,
  transition: { kind: "cut" as const, ms: 0 },
  bytes,
});

const playlist = (id: string, items: ReturnType<typeof item>[]) => ({
  id,
  startedAt: 0,
  fit: "contain" as const,
  transition: { kind: "cut" as const, ms: 0 },
  items,
});

const H: SignageHorizon = [
  {
    from: 0, until: 10_000, reason: "schedule", reasonLabel: "A",
    playlist: playlist("a", [item("/a1.png", 100), item("/a2.png", 100)]),
  },
  {
    from: 10_000, until: 20_000, reason: "schedule", reasonLabel: "B",
    playlist: playlist("b", [item("/b1.png", 100), item("/b2.png", 100)]),
  },
];

describe("what a display fetches ahead", () => {
  test("the whole current window, plus the FIRST item of the next", () => {
    // The next window's first item is what covers the boundary itself; fetching
    // all of it would be the whole day's media.
    assert.deepEqual(planPrefetch(H, 5000, 1e9).urls, ["/a1.png", "/a2.png", "/b1.png"]);
  });

  test("stops at the cap and REPORTS what it dropped", () => {
    const r = planPrefetch(H, 5000, 150);
    assert.deepEqual(r.urls, ["/a1.png"]);
    assert.deepEqual(r.skipped.map((s) => s.url), ["/a2.png", "/b1.png"]);
  });

  test("a cap of zero fetches nothing and says so, rather than silently idling", () => {
    const r = planPrefetch(H, 5000, 0);
    assert.deepEqual(r.urls, []);
    assert.equal(r.skipped.length, 3);
  });

  test("a blank current entry still warms the next window's first item", () => {
    // The screen is dark now, and the thing that must not stutter is what comes
    // after the dark.
    const blankFirst: SignageHorizon = [
      { from: 0, until: 10_000, reason: "blank", reasonLabel: "" },
      H[1],
    ];
    assert.deepEqual(planPrefetch(blankFirst, 5000, 1e9).urls, ["/b1.png"]);
  });

  test("a blank NEXT entry adds nothing", () => {
    const blankNext: SignageHorizon = [
      H[0],
      { from: 10_000, until: 20_000, reason: "blank", reasonLabel: "" },
    ];
    assert.deepEqual(planPrefetch(blankNext, 5000, 1e9).urls, ["/a1.png", "/a2.png"]);
  });

  test("the last entry in the horizon has no next window", () => {
    assert.deepEqual(planPrefetch(H, 15_000, 1e9).urls, ["/b1.png", "/b2.png"]);
  });

  test("outside the horizon it fetches nothing rather than guessing", () => {
    assert.deepEqual(planPrefetch(H, 99_000, 1e9).urls, []);
  });

  test("an empty horizon fetches nothing", () => {
    assert.deepEqual(planPrefetch([], 5000, 1e9).urls, []);
  });

  test("the same url twice is fetched once", () => {
    // A graphic that ends one playlist and starts the next is common, and
    // counting it twice would spend the cap on bytes already held.
    const shared: SignageHorizon = [
      { from: 0, until: 10_000, reason: "schedule", reasonLabel: "A", playlist: playlist("a", [item("/x.png", 100)]) },
      { from: 10_000, until: 20_000, reason: "schedule", reasonLabel: "B", playlist: playlist("b", [item("/x.png", 100)]) },
    ];
    assert.deepEqual(planPrefetch(shared, 5000, 1e9).urls, ["/x.png"]);
  });
});
