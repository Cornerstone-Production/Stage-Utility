// Every channel the UI invokes must have a case in api.ts.
//
// `invoke()` takes `channel: string`, so a channel with no case is not a compile
// error — it throws at runtime, in the click handler, in front of an operator.
// The baptism trigger panel shipped that way and nobody noticed for months: its
// load path swallowed the throw, so saved triggers simply read as "none set",
// and only pressing Save surfaced `Unknown IPC channel`. The panel rendered,
// accepted input, and could not persist a thing.
//
// This is the cheap structural guard until `invoke` takes a channel union: scan
// what the UI actually calls and check every one is wired.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.resolve(HERE, "..");
const API_TS = path.join(HERE, "api.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Channels api.ts can actually dispatch. */
function handledChannels(): Set<string> {
  const src = fs.readFileSync(API_TS, "utf8");
  return new Set([...src.matchAll(/case\s+"([^"]+)"\s*:/g)].map((m) => m[1]!));
}

/** Channels the UI passes to invoke(), as a literal, with the file that does it. */
function invokedChannels(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(RENDERER)) {
    if (path.resolve(file) === API_TS) continue;
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g)) {
      const chan = m[1]!;
      const where = path.relative(RENDERER, file);
      const list = found.get(chan);
      if (list) { if (!list.includes(where)) list.push(where); } else found.set(chan, [where]);
    }
  }
  return found;
}

describe("IPC channel wiring", () => {
  it("has a case for every channel the UI invokes", () => {
    const handled = handledChannels();
    const missing = [...invokedChannels()]
      .filter(([chan]) => !handled.has(chan))
      .map(([chan, files]) => `  ${chan}  <- ${files.join(", ")}`);

    assert.equal(
      missing.length,
      0,
      `invoke() would throw "Unknown IPC channel" for:\n${missing.join("\n")}`,
    );
  });

  it("finds the channels at all, so a broken scan cannot pass silently", () => {
    // If the regex stops matching (invoke is renamed, call sites are reshaped),
    // the test above passes vacuously. Anchor it to a channel that must exist.
    const invoked = invokedChannels();
    assert.ok(invoked.size > 20, `only found ${invoked.size} invoked channels — scan looks broken`);
    assert.ok(invoked.has("stage:getState"), "expected stage:getState among the invoked channels");
  });
});
