import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readBundleFile } from "./read-bundle-file.js";

const file = (text: string): File => new File([text], "x.json");

describe("readBundleFile", () => {
  test("returns the parsed bundle when its kind matches", async () => {
    assert.deepEqual(await readBundleFile(file('{"kind":"k","n":1}'), "k", "a thing"), { kind: "k", n: 1 });
  });
  test("says a file that is not JSON is not JSON, not a SyntaxError", async () => {
    await assert.rejects(readBundleFile(file("{nope"), "k", "a thing"), { message: "That file is not JSON, so it is not a thing." });
  });
  test("names the wrong kind, cut at 60 characters, and 'unknown' when there is none", async () => {
    await assert.rejects(readBundleFile(file(JSON.stringify({ kind: "x".repeat(200) })), "k", "a thing"), {
      message: `That is a "${"x".repeat(60)}" file, not a thing.`,
    });
    await assert.rejects(readBundleFile(file("{}"), "k", "a thing"), { message: 'That is a "unknown" file, not a thing.' });
    await assert.rejects(readBundleFile(file("null"), "k", "a thing"), { message: 'That is a "unknown" file, not a thing.' });
  });
});
