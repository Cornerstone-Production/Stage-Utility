import { strict as assert } from "node:assert";
import { test } from "node:test";

import { pressCommand } from "./command-answer.js";

test("a press that reached a device says nothing", async () => {
  assert.equal(await pressCommand("rec_on", async () => ({ status: 200, ok: true })), null);
});

test("a refusal is returned as its note", async () => {
  assert.equal(await pressCommand("rec_on", async () => ({ status: 409, error: "Busy" })), "Busy");
});

test("a request that failed outright is a note, not a throw", async () => {
  const said = await pressCommand("rec_on", async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(said, "Could not reach the server: fetch failed");
});
