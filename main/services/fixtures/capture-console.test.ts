// The fixture the credential-leak guards read the console through. If it
// printed "[object Object]" for an object, a guard would pass on a log line
// that carries the secret.

import { test } from "node:test";
import assert from "node:assert/strict";
import { captureConsole, captureConsoleDuring, captureConsoleDuringAsync } from "./capture-console.js";

test("an object handed to the console shows its fields", (t) => {
  const lines = captureConsole(t, "warn");
  console.warn("[x] moved", { config: { password: "hunter2" } });
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("hunter2"), lines[0]);
});

test("strings pass through unquoted and an Error prints as the console prints it", (t) => {
  const lines = captureConsole(t, "log", "error");
  console.log("a", 1, ["b"]);
  console.error("failed:", new Error("boom"));
  assert.deepEqual(lines, ["a 1 [ 'b' ]", "failed: Error: boom"]);
});

test("captureConsoleDuring puts the console back when the callback throws", () => {
  const before = console.warn;
  assert.throws(() => captureConsoleDuring(["warn"], () => { throw new Error("boom"); }), /boom/);
  assert.equal(console.warn, before);
});

test("captureConsoleDuring returns what was written inside, and nothing after", () => {
  const lines = captureConsoleDuring(["log", "warn"], () => {
    console.log("in", { k: "v" });
    console.warn("also");
  });
  console.log("after");
  assert.deepEqual(lines, ["in { k: 'v' }", "also"]);
});

test("captureConsoleDuringAsync waits for the callback and restores on a rejection", async () => {
  const before = console.log;
  const lines = await captureConsoleDuringAsync(["log"], async () => {
    await Promise.resolve();
    console.log("late");
  });
  assert.deepEqual(lines, ["late"]);
  await assert.rejects(captureConsoleDuringAsync(["log"], async () => { throw new Error("no"); }), /no/);
  assert.equal(console.log, before);
});
