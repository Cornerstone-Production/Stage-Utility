// The rules file is not always something this app wrote.
//
// `POST /api/automation/rules` and its PATCH both run assertCueValid, so no cue
// this app saved can have an unusable name, a name that collides with another
// rule's, or a state binding Companion could not answer for. `init()` ran none
// of it: `this.rules = await automationStore.loadRules()` and straight on.
//
// The ways in are real. A restored config archive replaces automation-rules.json
// wholesale. So does copying one install's data directory onto another. So does
// a hand edit, which this repo already treats as a path worth holding — the
// state binding is read off a pair's `_off` half as a fallback for exactly that
// reason, three modules away.
//
// What arrives that way is a cue the routes would refuse, live, with nothing
// anywhere saying so. `__proto___on` is the sharp one: the pair's base is
// `__proto__`, which is half the key every surface downstream — the states
// route, the cues channel, the manifest, the generated Home Assistant switch —
// is keyed by.
//
// REPORTED, NOT REMOVED, and not fatal either. Deleting is destroying the
// operator's own work to tidy something up; throwing means one bad line in a
// restored archive is a server that will not boot at 8:55 on a Sunday. The
// warning is the whole deliverable: an operator reading /log can see which rule
// and why.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "cue-init-validate-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

/** One call-by-name cue, exactly as automation-rules.json stores it. */
function cue(name: string, params: Record<string, string | number> = {}) {
  return {
    id: `id-${name}`,
    name: `Rule ${name}`,
    enabled: true,
    trigger: { id: "call.by-name", params: { name, ...params } },
    conditions: [],
    action: { id: "log.message", params: { message: "pressed" } },
    cooldownSec: 0,
    oncePerService: false,
  };
}

// WRITTEN BEFORE THE IMPORT. The engine is a module singleton and `init()` is
// what reads the file, so the file has to exist first — and it is the real
// DataStore path, not a seam, because the seam is what the restore writes
// around.
await fs.writeFile(
  path.join(TMP, "automation-rules.json"),
  JSON.stringify([
    // A pair whose base is `__proto__`. CUE_NAME_RE refuses a leading
    // underscore, so this cannot be created through the API at all.
    cue("__proto___on", { stateVariable: "proto_state" }),
    cue("__proto___off"),
    // A binding naming something Companion could not answer for.
    cue("bad_binding_on", { stateVariable: "not a variable name!" }),
    // And one ordinary, valid cue, so a check that condemned everything would
    // show up here rather than reading as a pass.
    cue("projectors_on"),
    cue("projectors_off"),
  ]),
  "utf8",
);

const { automationEngine } = await import("./automation-engine.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

let warnings: string[] = [];

before(async () => {
  const realWarn = console.warn;
  warnings = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    await automationEngine.init();
  } finally {
    console.warn = realWarn;
  }
});

describe("init() runs the write path's own validation over the loaded rules", () => {
  test("every refusable cue is named, with the reason, and nothing else is", () => {
    // EXACT, not a floor. A floor passes with the check reduced to one rule,
    // and with the valid cues condemned along with the bad ones.
    assert.deepEqual(
      warnings.filter((w) => w.includes("would be refused")).sort(),
      [
        '[cues] rule "Rule __proto___off" would be refused if you saved it: ' +
          '"__proto___off" is not a usable cue name — use lower_snake_case',
        '[cues] rule "Rule __proto___on" would be refused if you saved it: ' +
          '"__proto___on" is not a usable cue name — use lower_snake_case',
        '[cues] rule "Rule bad_binding_on" would be refused if you saved it: ' +
          '"not a variable name!" is not a Companion variable — a custom variable ' +
          "(letters, digits, _, - and . only) or <connection label>:<variable name>",
      ],
    );
  });

  test("and NOTHING is deleted — the operator's own file is still all five rules", () => {
    // The other half, and the more important one. A check that "fixed" the file
    // by dropping what it could not validate would pass the test above.
    assert.deepEqual(
      automationEngine.listRules().map((r) => String(r.trigger.params.name)),
      ["__proto___on", "__proto___off", "bad_binding_on", "projectors_on", "projectors_off"],
    );
  });
});
