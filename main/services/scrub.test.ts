import { strict as assert } from "node:assert";
import { test } from "node:test";

import { scrub } from "./scrub.js";

// Control characters are written as escapes throughout. A test file containing
// literal ones is treated as binary by git and cannot be reviewed.
const ESC = "\u001b";
const CSI = "\u009b";
const NUL = "\u0000";
const LS = "\u2028"; // LINE SEPARATOR — a line break to many log viewers
const PS = "\u2029"; // PARAGRAPH SEPARATOR

test("a forged log line cannot survive", () => {
  // The attack this exists for: a display named so that its own log entry
  // appears to be a second, server-written line.
  const name = "Stage\n[stage-controller] plan switched to 12345";
  const out = scrub(name);
  assert.ok(!out.includes("\n"), "no newline may survive");
  assert.equal(out, "Stage\\n[stage-controller] plan switched to 12345");
  assert.equal(`[server] display renamed to ${out}`.split("\n").length, 1, "still one line");
});

test("every line-breaking character is escaped", () => {
  for (const [raw, want] of [
    ["\n", "\\n"],
    ["\r", "\\r"],
    ["\t", "\\t"],
    [LS, "\\u2028"],
    [PS, "\\u2029"],
    [NUL, "\\x00"],
    [ESC, "\\x1b"],
    [CSI, "\\x9b"],
  ] as const) {
    assert.equal(scrub(`a${raw}b`), `a${want}b`, `${JSON.stringify(raw)} should escape`);
  }
});

test("a terminal escape sequence cannot repaint the log", () => {
  // ESC[2J clears the screen of anything tailing the log.
  const out = scrub(`done${ESC}[2J${ESC}[H`);
  assert.ok(!out.includes(ESC));
  assert.equal(out, "done\\x1b[2J\\x1b[H");
});

test("ordinary text is untouched", () => {
  for (const s of ["display-1", "Sunday 9am — Auditorium", "Ross XPT 1:2", "café 日本語"]) {
    assert.equal(scrub(s), s);
  }
});

test("length is bounded, so one value cannot flood the log", () => {
  const out = scrub("x".repeat(5000));
  assert.equal(out.length, 201, "200 characters plus the ellipsis");
  assert.ok(out.endsWith("…"));
});

test("the bound is applied after escaping, not before", () => {
  // Otherwise 200 newlines would become 400 characters of output.
  const out = scrub("\n".repeat(500));
  assert.ok(out.length <= 201, `expected a bounded result, got ${out.length}`);
});

// ── Values that are not strings ────────────────────────────────────────────

test("an object with a hostile toString cannot bypass this", () => {
  const evil = { toString: () => "ok\n[server] forged" };
  const out = scrub(evil);
  assert.ok(!out.includes("\n"), `newline survived: ${JSON.stringify(out)}`);
});

test("an Error contributes its message, escaped", () => {
  assert.equal(scrub(new Error("bad\nthing")), "bad\\nthing");
});

test("null and undefined are readable rather than blank", () => {
  assert.equal(scrub(null), "null");
  assert.equal(scrub(undefined), "undefined");
});

test("a circular object does not throw", () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  assert.equal(scrub(a), "[unserialisable]");
});

test("numbers and booleans render as themselves", () => {
  assert.equal(scrub(42), "42");
  assert.equal(scrub(true), "true");
});
