// The fixture the credential-leak guards read the console through. If it
// printed "[object Object]" for an object, a guard would pass on a log line
// that carries the secret.

import { test } from "node:test";
import assert from "node:assert/strict";
import { captureConsole } from "./capture-console.js";

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
