// Searching, filtering and sorting the library.
//
// The order this produces is the order a shift-click extends over, so getting it
// wrong selects things the operator cannot see.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignageMedia } from "@main/types/signage";

import { DEFAULT_VIEW, orderMedia, type MediaView } from "./media-order";

const item = (
  id: string,
  name: string,
  o: { mime?: string; bytes?: number; createdAt?: string } = {},
): SignageMedia => ({
  id,
  file: `${id.padEnd(16, "0")}.png`,
  name,
  mime: o.mime ?? "image/png",
  bytes: o.bytes ?? 1000,
  w: 1920,
  h: 1080,
  createdAt: o.createdAt ?? "2026-08-01T00:00:00.000Z",
});

const LIBRARY: SignageMedia[] = [
  item("m1", "Welcome", { createdAt: "2026-08-01T00:00:00.000Z", bytes: 5000 }),
  item("m2", "Bienvenido á casa", { createdAt: "2026-08-03T00:00:00.000Z", bytes: 1000 }),
  item("m3", "Building fund", { createdAt: "2026-08-02T00:00:00.000Z", bytes: 9000 }),
  item("m4", "Sermon bumper", { mime: "video/mp4", createdAt: "2026-08-04T00:00:00.000Z", bytes: 14_000_000 }),
];

const view = (over: Partial<MediaView> = {}): MediaView => ({ ...DEFAULT_VIEW, ...over });
const names = (m: SignageMedia[]) => m.map((x) => x.name);

describe("filtering by kind", () => {
  test("graphics leaves the video out", () => {
    assert.equal(names(orderMedia(LIBRARY, view({ kind: "image" }))).includes("Sermon bumper"), false);
  });

  test("video leaves everything else out", () => {
    assert.deepEqual(names(orderMedia(LIBRARY, view({ kind: "video" }))), ["Sermon bumper"]);
  });

  test("everything is everything", () => {
    assert.equal(orderMedia(LIBRARY, view({ kind: "all" })).length, 4);
  });
});

describe("search", () => {
  test("matches part of a name, in any case", () => {
    assert.deepEqual(names(orderMedia(LIBRARY, view({ search: "BUILD" }))), ["Building fund"]);
  });

  test("ignores accents, in both directions", () => {
    // The library has real filenames in it. Someone searching "casa" does not
    // know whether the uploader's keyboard produced an "a" or an "á".
    assert.deepEqual(names(orderMedia(LIBRARY, view({ search: "bienvenido" }))), ["Bienvenido á casa"]);
    assert.deepEqual(names(orderMedia(LIBRARY, view({ search: "a casa" }))), ["Bienvenido á casa"]);
  });

  test("whitespace alone is not a search", () => {
    assert.equal(orderMedia(LIBRARY, view({ search: "   " })).length, 4);
  });

  test("no match is an empty list, not everything", () => {
    assert.deepEqual(orderMedia(LIBRARY, view({ search: "nothing here" })), []);
  });

  test("search and kind apply together", () => {
    assert.deepEqual(names(orderMedia(LIBRARY, view({ search: "e", kind: "video" }))), ["Sermon bumper"]);
  });
});

describe("sorting", () => {
  test("newest first", () => {
    assert.deepEqual(names(orderMedia(LIBRARY, view({ sort: "recent" }))), [
      "Sermon bumper", "Bienvenido á casa", "Building fund", "Welcome",
    ]);
  });

  test("oldest first is the exact reverse", () => {
    assert.deepEqual(
      names(orderMedia(LIBRARY, view({ sort: "oldest" }))),
      names(orderMedia(LIBRARY, view({ sort: "recent" }))).reverse(),
    );
  });

  test("largest first", () => {
    assert.deepEqual(names(orderMedia(LIBRARY, view({ sort: "largest" })))[0], "Sermon bumper");
  });

  test("by name, numerically — slide 2 before slide 10", () => {
    // The whole reason anyone sorts a media library by name.
    const slides = [item("s10", "Slide 10"), item("s2", "Slide 2"), item("s1", "Slide 1")];
    assert.deepEqual(names(orderMedia(slides, view({ sort: "name" }))), ["Slide 1", "Slide 2", "Slide 10"]);
  });

  test("two files uploaded in the same millisecond keep a stable order", () => {
    // A multi-file drop stamps identical createdAt. Without a tie-break the two
    // swap places between renders and move under the pointer mid-click.
    const same = [
      item("mb", "B", { createdAt: "2026-08-05T00:00:00.000Z" }),
      item("ma", "A", { createdAt: "2026-08-05T00:00:00.000Z" }),
    ];
    const once = names(orderMedia(same, view({ sort: "recent" })));
    const twice = names(orderMedia([...same].reverse(), view({ sort: "recent" })));
    assert.deepEqual(once, twice, "the order depended on the input order");
  });

  test("does not mutate the library it was given", () => {
    // sort() is in-place, and the array handed in is React Query's cache.
    const before = LIBRARY.map((m) => m.id);
    orderMedia(LIBRARY, view({ sort: "name" }));
    assert.deepEqual(LIBRARY.map((m) => m.id), before, "the cached library was reordered in place");
  });
});
