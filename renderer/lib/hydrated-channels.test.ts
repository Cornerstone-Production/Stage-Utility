import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { HYDRATED_CHANNELS } from "./api.js";

// The server pushes a snapshot of these channels the moment a stream connects.
// A client that subscribes later missed it, so api.ts caches the last payload and
// replays it — which only works if the two lists agree. Rather than trusting that
// by hand, read the server and compare.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function serverHydratedChannels(): string[] {
  const src = readFileSync(path.join(ROOT, "main/services/remote-server.ts"), "utf8");
  return [...src.matchAll(/sseWrite\(res,\s*"([^"]+)"/g)].map((m) => m[1]);
}

test("the scan finds the server's hydrates at all", () => {
  // Guards the regex — a silently-empty scan would make this file vacuous.
  assert.ok(serverHydratedChannels().length >= 10, "expected to find sseWrite hydrate calls");
});

test("every channel the server hydrates is replayed to late subscribers", () => {
  const missing = serverHydratedChannels().filter((c) => !(HYDRATED_CHANNELS as readonly string[]).includes(c));
  assert.deepEqual(
    missing,
    [],
    `hydrated by the server but not replayed — a tab mounting later will miss it: ${missing.join(", ")}`,
  );
});

test("nothing is replayed that the server does not hydrate", () => {
  // A command channel replayed on subscribe would re-fire the command.
  const server = new Set(serverHydratedChannels());
  const extra = HYDRATED_CHANNELS.filter((c) => !server.has(c));
  assert.deepEqual(extra, [], `replayed but never hydrated: ${extra.join(", ")}`);
});

test("display:refresh is not replayed", () => {
  // The specific footgun: replaying it would reload every screen on a tab switch.
  assert.ok(!(HYDRATED_CHANNELS as readonly string[]).includes("display:refresh"));
});
