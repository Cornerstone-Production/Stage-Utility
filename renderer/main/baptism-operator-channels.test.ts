// Every "baptism:" channel this panel actually dispatches must resolve through
// the real invoke() switch in renderer/lib/api.ts, not just exist in prose.
//
// A plain source-text scan for `invoke("baptism:...")` / `act("baptism:...")`
// calls misses this panel's own Pause button: `act(paused ? "baptism:resume" :
// "baptism:pause")` puts the literal behind a ternary, not directly after the
// call. That gap is exactly how pause/resume shipped, on `main`, with a button
// that threw "Unknown IPC channel" on every press — renderer/lib/api.ts never
// grew a case for either, and the panel's own act() swallows the throw into a
// toast, so the timer kept running and nothing but the toast said anything was
// wrong.
//
// So this does not scan for a call shape at all. Step one extracts every
// "baptism:xxx" STRING LITERAL in the panel's source (comments stripped first —
// this file has no string literal containing `//` or `/*`, so a straight strip
// is safe here, and it is what keeps a channel merely NAMED in a doc comment
// from satisfying this the way `baptism:state` is, two lines up from the top of
// the component). Step two EXECUTES the real `invoke` switch for each literal
// found — with fetch stubbed so nothing reaches the network — and asserts none
// of them throw the unknown-channel error. A comment cannot make invoke() not
// throw; only a real `case` can.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.join(HERE, "baptism-operator.tsx");

/** Every "baptism:xxx" string literal the panel's source contains, once
 *  comments are stripped out. */
function panelChannels(): string[] {
  const src = fs.readFileSync(PANEL, "utf8");
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const found = new Set<string>();
  for (const m of stripped.matchAll(/"(baptism:[\w-]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

// EXACT, sorted, one entry per line — never a bare count. A count cannot tell an
// add plus a remove from no change, and two branches each adding a channel here
// would merge clean past a number.
const EXPECTED_CHANNELS = [
  "baptism:advance",
  "baptism:baptized",
  "baptism:deleteSession",
  "baptism:finish",
  "baptism:next",
  "baptism:pause",
  "baptism:reset",
  "baptism:resume",
  "baptism:sessions",
  "baptism:setMode",
  "baptism:start",
  "baptism:startBaptisms",
  "baptism:undo",
];

describe("baptism-operator.tsx channel wiring", () => {
  it("finds exactly this sorted list of channels in the panel's source", () => {
    assert.deepEqual(
      panelChannels(),
      EXPECTED_CHANNELS,
      "the panel now names a different set of baptism: channels than this list — update it deliberately",
    );
  });

  it("every one of them resolves through the real invoke() switch", async () => {
    const { invoke } = await import("../lib/api.js");
    const realFetch = globalThis.fetch;
    // Nothing here is about what the server returns — only about whether
    // invoke() recognises the channel at all — so every request just succeeds.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    try {
      const unknown: string[] = [];
      for (const channel of panelChannels()) {
        try {
          await invoke(channel);
        } catch (err) {
          // Only the routing failure this guard exists for counts. A channel
          // whose case needs a real argument we didn't pass (e.g. an id) may
          // still throw for an unrelated reason — that is a different bug,
          // caught elsewhere, not what "is this channel wired at all" is
          // asking.
          if (err instanceof Error && err.message.includes("Unknown IPC channel")) {
            unknown.push(channel);
          }
        }
      }
      assert.deepEqual(
        unknown,
        [],
        `invoke() throws "Unknown IPC channel" for: ${unknown.join(", ")} — the panel calls ` +
          "these but renderer/lib/api.ts has no case for them",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
