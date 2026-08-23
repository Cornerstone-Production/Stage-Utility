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

import { resolveItemDurations, toHorizonItems } from "./signage-playlist-items.js";

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

describe("trimming a video", () => {
  const clip = {
    id: "v1",
    file: "cccccccccccccccc.mp4",
    name: "bumper",
    mime: "video/mp4",
    bytes: 1,
    w: 1920,
    h: 1080,
    durationMs: 42_000,
    createdAt: "",
  };
  const playlist = (item: Record<string, unknown>) => ({
    id: "pl",
    name: "pl",
    items: [{ mediaId: "v1", ...item }],
    defaultDurationMs: 8000,
    fit: "contain" as const,
    transition: { kind: "cut" as const, ms: 0 },
    createdAt: "",
  });

  test("an untrimmed clip is its own length, and carries no trim", () => {
    const [r] = resolveItemDurations(playlist({}) as never, [clip]);
    assert.equal(r.durationMs, 42_000);
    assert.equal(r.trimStartMs, undefined, "an untrimmed clip must not change its own URL");
  });

  test("the item's duration becomes the TRIMMED length", () => {
    // The whole reason to trim rather than shorten a duration, which for video
    // is ignored: a lap of the playlist gets shorter with it.
    const [r] = resolveItemDurations(playlist({ trimStartMs: 10_000, trimEndMs: 25_000 }) as never, [clip]);
    assert.equal(r.durationMs, 15_000);
    assert.equal(r.trimStartMs, 10_000);
    assert.equal(r.trimEndMs, 25_000);
  });

  test("trimming only the head works", () => {
    const [r] = resolveItemDurations(playlist({ trimStartMs: 2000 }) as never, [clip]);
    assert.equal(r.durationMs, 40_000);
  });

  test("trimming only the tail works", () => {
    const [r] = resolveItemDurations(playlist({ trimEndMs: 5000 }) as never, [clip]);
    assert.equal(r.durationMs, 5000);
  });

  test("an out point past the end clamps to the end", () => {
    // Rather than a clip that claims to run longer than it does and leaves the
    // playlist showing a frozen last frame for the difference.
    const [r] = resolveItemDurations(playlist({ trimEndMs: 99_000 }) as never, [clip]);
    assert.equal(r.durationMs, 42_000);
  });

  test("a negative in point clamps to the start", () => {
    const [r] = resolveItemDurations(playlist({ trimStartMs: -5000 }) as never, [clip]);
    assert.equal(r.durationMs, 42_000);
  });

  test("an in point past the out point drops the item", () => {
    // A zero-length turn is worse than a missing one: the cycle skips it
    // invisibly and the operator sees a clip that never plays with nothing
    // saying why. Dropped, it is visible as a shorter list.
    assert.deepEqual(resolveItemDurations(playlist({ trimStartMs: 30_000, trimEndMs: 10_000 }) as never, [clip]), []);
  });

  test("a trim that leaves nothing at all drops the item", () => {
    assert.deepEqual(resolveItemDurations(playlist({ trimStartMs: 5000, trimEndMs: 5000 }) as never, [clip]), []);
  });

  test("nonsense clamps rather than throwing", () => {
    // A hand-edited store, or a NaN from a form.
    const [r] = resolveItemDurations(
      playlist({ trimStartMs: Number.NaN, trimEndMs: Number.POSITIVE_INFINITY }) as never,
      [clip],
    );
    assert.equal(r.durationMs, 42_000);
  });

  test("an image ignores trim points entirely", () => {
    const image = { ...clip, id: "i1", file: "dddddddddddddddd.png", mime: "image/png", durationMs: undefined };
    const [r] = resolveItemDurations(
      { ...playlist({ trimStartMs: 1000, trimEndMs: 2000 }), items: [{ mediaId: "i1", trimStartMs: 1000, trimEndMs: 2000 }] } as never,
      [image as never],
    );
    assert.equal(r.durationMs, 8000, "an image took its length from a video trim");
    assert.equal(r.trimStartMs, undefined);
  });

  test("the trim reaches the horizon item the player reads", () => {
    const resolved = resolveItemDurations(playlist({ trimStartMs: 10_000, trimEndMs: 25_000 }) as never, [clip]);
    const [item] = toHorizonItems(resolved);
    assert.equal(item.durationMs, 15_000);
    assert.equal(item.trimStartMs, 10_000);
    assert.equal(item.trimEndMs, 25_000);
  });
});
