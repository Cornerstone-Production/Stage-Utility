import { strict as assert } from "node:assert";
import { test } from "node:test";
import { feedIdFor, isReservedFeedId, FEED_ID_PATTERN } from "./feed-id.js";

test("slugs a name", () => assert.equal(feedIdFor("Program (IMAG)", new Set()), "program-imag"));
test("never empty", () => assert.equal(feedIdFor("!!!", new Set()), "feed"));
test("unique by suffix", () => assert.equal(feedIdFor("PTZ", new Set(["ptz", "ptz-2"])), "ptz-3"));
test("capped at 40 and still valid", () => {
  const id = feedIdFor("a".repeat(80), new Set());
  assert.ok(id.length <= 40 && FEED_ID_PATTERN.test(id));
});
test("a numeric suffix never pushes an id past 40", () => {
  const base = "a".repeat(36);
  const taken = new Set([base, ...Array.from({ length: 998 }, (_, i) => `${base}-${i + 2}`)]);
  const id = feedIdFor(base, taken);
  assert.ok(id.length <= 40 && FEED_ID_PATTERN.test(id), id);
  assert.ok(!taken.has(id));
});
test("a base cut to make room for the suffix does not end in a hyphen", () => {
  const base = `${"a".repeat(34)}-b`;
  const taken = new Set([base, ...Array.from({ length: 998 }, (_, i) => `${base}-${i + 2}`)]);
  const id = feedIdFor(base, taken);
  assert.ok(id.length <= 40 && FEED_ID_PATTERN.test(id), id);
});
test("prototype names are ordinary ids", () => {
  assert.equal(feedIdFor("__proto__", new Set()), "proto");
});
test("accents fold into their letters rather than splitting the word", () => {
  assert.equal(feedIdFor("Résumé cam", new Set()), "resume-cam");
  assert.equal(feedIdFor("Façade Ñandú", new Set()), "facade-nandu");
});

// A feed's `<id>-listen` relay path carries its converted audio, so an id of that
// shape would be two feeds on one path.
test("no feed id ends in -listen, whichever feed is made first", () => {
  assert.equal(feedIdFor("Cam Listen", new Set()), "cam-listen-2");
  assert.equal(feedIdFor("Cam", new Set(["cam-listen-2"])), "cam");
  const first = feedIdFor("Cam", new Set());
  assert.equal(first, "cam");
  assert.equal(feedIdFor("Cam Listen", new Set([first])), "cam-listen-2");
  assert.equal(feedIdFor("Cam Listen", new Set(["cam-listen-2"])), "cam-listen-3");
  assert.equal(feedIdFor("Listen", new Set()), "listen", "only the suffix is reserved");
});

test("isReservedFeedId names exactly the -listen shape", () => {
  assert.equal(isReservedFeedId("cam-listen"), true);
  assert.equal(isReservedFeedId("cam-listening"), false);
  assert.equal(isReservedFeedId("listen"), false);
});
