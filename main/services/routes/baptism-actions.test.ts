// The `/api/baptism/` action switch in history-routes.ts, guarded independently
// of renderer/lib/api-channels.test.ts.
//
// That guard only proves api.ts has a `case` for a channel — it stubs `fetch`,
// so it never reaches the server at all. A reviewer deleted `case "advance":`
// from the switch below and all 7169 other tests stayed green: route-coverage
// scanning only sees the `/api/baptism/` PREFIX, not which actions the switch
// inside it actually handles. This reads the real switch's source and pins its
// case labels as an EXACT sorted list — a bare count would not tell an action
// added in one branch and removed in another from no change at all.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_ROUTES = path.join(HERE, "history-routes.ts");
const SWITCH_MARKER = "switch (action) {";

/** The case labels inside the ONE `switch (action)` block that dispatches
 *  `/api/baptism/<action>`, found by counting braces from its opening `{` to
 *  its matching close — not a whole-file scan, so a same-named case elsewhere
 *  in this file cannot satisfy it. */
function baptismActions(): string[] {
  const src = fs.readFileSync(HISTORY_ROUTES, "utf8");
  const start = src.indexOf(SWITCH_MARKER);
  if (start === -1) {
    throw new Error(`"${SWITCH_MARKER}" not found in history-routes.ts — did the /api/baptism/ dispatch move or get renamed?`);
  }
  let depth = 0;
  let end = -1;
  for (let i = start + SWITCH_MARKER.length - 1; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error("unbalanced switch (action) block in history-routes.ts");
  const block = src.slice(start, end);
  return [...block.matchAll(/case\s+"([^"]+)"\s*:/g)].map((m) => m[1]!).sort();
}

// EXACT, sorted, one entry per line — never a bare count. A count cannot tell an
// add plus a remove from no change, and two branches each adding a different
// action would merge clean past a number.
const EXPECTED_ACTIONS = [
  "advance",
  "baptized",
  "dismiss-save-error",
  "finish",
  "mode",
  "next",
  "pause",
  "reset",
  "resume",
  "start",
  "start-baptisms",
  "undo",
];

describe("the /api/baptism/ action switch", () => {
  it("handles exactly this sorted list of actions", () => {
    assert.deepEqual(
      baptismActions(),
      EXPECTED_ACTIONS,
      "the switch now handles a different set of actions than this list — update it deliberately",
    );
  });
});
