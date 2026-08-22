// How long each playlist item is on screen, and which items can play at all.
//
// One rule is worth more than the rest: a VIDEO ignores both the per-item
// duration and the playlist default, and uses the clip's own length. Anything
// else cuts a 42-second clip off after 8 seconds because that is what the
// playlist happens to default to, which reads as a broken video rather than a
// misconfigured playlist.
//
// It lives in main/ rather than beside the editor because BOTH sides need it and
// must agree: the resolver builds the horizon from it, and the playlist editor
// shows the operator the cycle length it produces. Two implementations of this
// rule would drift, and the symptom would be an editor that disagrees with the
// wall.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { resolveItemDurations } from "./signage-playlist-items.js";

const MEDIA = [
  { id: "m1", file: "a.png", name: "a", mime: "image/png", bytes: 1, w: 1920, h: 1080, createdAt: "" },
  { id: "m2", file: "b.mp4", name: "b", mime: "video/mp4", bytes: 1, w: 1920, h: 1080, durationMs: 42000, createdAt: "" },
] as never;

const playlist = (items: unknown[], defaultDurationMs = 8000) =>
  ({
    id: "p1",
    name: "P",
    items,
    defaultDurationMs,
    fit: "contain",
    transition: { kind: "cut", ms: 0 },
    createdAt: "",
  }) as never;

describe("how long each item is on screen", () => {
  test("an image falls back to the playlist default", () => {
    const r = resolveItemDurations(playlist([{ mediaId: "m1" }]), MEDIA);
    assert.equal(r[0].durationMs, 8000);
  });

  test("a per-item duration wins for an image", () => {
    const r = resolveItemDurations(playlist([{ mediaId: "m1", durationMs: 15000 }]), MEDIA);
    assert.equal(r[0].durationMs, 15000);
  });

  test("a video uses its OWN length and ignores both", () => {
    const r = resolveItemDurations(playlist([{ mediaId: "m2", durationMs: 8000 }]), MEDIA);
    assert.equal(r[0].durationMs, 42000, "a 42s clip was cut off at the playlist default");
  });

  test("a video with no recorded duration is dropped, not guessed at", () => {
    // The upload path rejects this, so it only happens to a hand-edited store.
    // Guessing would put an item on a wall for an invented length of time.
    const broken = [
      { id: "m2", file: "b.mp4", name: "b", mime: "video/mp4", bytes: 1, w: 1920, h: 1080, createdAt: "" },
    ] as never;
    assert.deepEqual(resolveItemDurations(playlist([{ mediaId: "m2" }]), broken), []);
  });

  test("an item whose media is gone is dropped, not rendered broken", () => {
    const r = resolveItemDurations(playlist([{ mediaId: "missing" }, { mediaId: "m1" }]), MEDIA);
    assert.equal(r.length, 1);
    assert.equal(r[0].mediaId, "m1");
  });

  test("dropping one item does not drop the rest", () => {
    const r = resolveItemDurations(
      playlist([{ mediaId: "m1" }, { mediaId: "gone" }, { mediaId: "m2" }]),
      MEDIA,
    );
    assert.deepEqual(r.map((i) => i.mediaId), ["m1", "m2"]);
  });

  test("a non-positive duration falls back rather than freezing the cycle", () => {
    // A zero-length item would take no time, so a playlist of them has a
    // zero-length cycle and nothing can play at all.
    assert.equal(resolveItemDurations(playlist([{ mediaId: "m1", durationMs: 0 }]), MEDIA)[0].durationMs, 8000);
    assert.equal(resolveItemDurations(playlist([{ mediaId: "m1", durationMs: -5 }]), MEDIA)[0].durationMs, 8000);
  });

  test("a playlist default of zero still yields a playable item", () => {
    const r = resolveItemDurations(playlist([{ mediaId: "m1" }], 0), MEDIA);
    assert.ok(r[0].durationMs > 0, "a zero default produced an unplayable item");
  });

  test("carries the fit and transition each item resolved to", () => {
    const r = resolveItemDurations(
      playlist([{ mediaId: "m1", fit: "cover", transition: { kind: "crossfade", ms: 400 } }]),
      MEDIA,
    );
    assert.equal(r[0].fit, "cover");
    assert.deepEqual(r[0].transition, { kind: "crossfade", ms: 400 });
  });

  test("an empty playlist resolves to nothing, not to a phantom item", () => {
    assert.deepEqual(resolveItemDurations(playlist([]), MEDIA), []);
  });
});
