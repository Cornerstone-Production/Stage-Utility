import { strict as assert } from "node:assert";
import { test } from "node:test";

import { serviceDirName } from "./archive-paths.js";

test("names a directory by date then sanitised key", () => {
  assert.equal(serviceDirName("st1:p123:t9", "2026-07-26"), "2026-07-26_st1-p123-t9");
});

test("collapses every character that is not [A-Za-z0-9._-]", () => {
  assert.equal(serviceDirName("a/b\\c:d e", "2026-07-26"), "2026-07-26_a-b-c-d-e");
});

test("cannot escape the archive root", () => {
  const name = serviceDirName("../../etc/passwd", "2026-07-26");
  assert.ok(!name.includes("/"), name);
  assert.ok(!name.includes(".."), name);
});

test("a bad date cannot escape either", () => {
  const name = serviceDirName("k", "../..");
  assert.ok(!name.includes("/") && !name.includes(".."), name);
});

test("an empty part never yields an empty segment", () => {
  assert.equal(serviceDirName("", ""), "unknown_unknown");
  assert.equal(serviceDirName("...", "2026-07-26"), "2026-07-26_unknown");
});
