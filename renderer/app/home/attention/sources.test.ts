// The set of attention sources, pinned.
//
// A source added without a test of its own is the failure this exists for: each
// must fire, not fire, and contribute nothing while unknown, and that is a test
// somebody has to write. So the list is exact, sorted, one per line, and it is
// checked three ways against three things that could each be forgotten:
// the file, its test, and its place in the registry.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ATTENTION_SOURCES } from "./sources/index.js";

const EXPECTED = [
  "integration-down",
  "readiness",
  "recorder-idle",
  "screen-offline",
  "wireless-battery",
  "wireless-offline",
];

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "sources");
const files = fs.readdirSync(DIR);

describe("attention sources", () => {
  it("the source files are exactly this list; add one deliberately, with its test", () => {
    const sources = files
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    assert.deepEqual(sources, EXPECTED);
  });

  it("every source has a test file of its own", () => {
    const untested = EXPECTED.filter((id) => !files.includes(`${id}.test.ts`));
    assert.deepEqual(untested, [], "a source with no <id>.test.ts: fires, does not fire, unknown contributes nothing");
  });

  it("the registry holds exactly these sources, each under the id of its file", () => {
    assert.deepEqual([...ATTENTION_SOURCES.map((s) => s.id)].sort(), EXPECTED);
  });

  it("the registry lists them in the order the docs table does", () => {
    assert.deepEqual(ATTENTION_SOURCES.map((s) => s.id), [
      "readiness",
      "wireless-battery",
      "wireless-offline",
      "screen-offline",
      "recorder-idle",
      "integration-down",
    ]);
  });
});
