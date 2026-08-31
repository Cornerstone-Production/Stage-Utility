// "Empty means all service types are allowed" — the contract every reader in
// this codebase implements, and which the boot path used to break.
//
// selectGlobalNextPlan, refreshServiceWindows and the Plan tab all branch on
// `allowed.length === 0` and treat it as "no restriction". The hydration in
// stage-controller did not: it substituted four hardcoded service-type ids for
// an empty list. Three consequences, all silent:
//
//   1. The Plan tab normalises "every type switched on" to [], so turning them
//      all on and restarting re-restricted the install to those four.
//   2. On any org but the one the ids came from they match nothing, so a fresh
//      install's service-type picker was empty with nothing to explain it.
//   3. They were another organisation's ids, in a public repository.
//
// The first test is the behavioural guard. The second is the leak guard, and it
// matches on an ARRAY OF QUOTED DIGIT STRINGS rather than on the specific ids —
// searching for the old numbers would pass the moment somebody pasted different
// ones, which is the same bug again.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(HERE, "..");

describe("an empty allowlist means every service type", () => {
  it("is what a fresh install starts with", async () => {
    const { DEFAULT_SETTINGS } = await import("./settings-store.js");
    assert.deepEqual(
      DEFAULT_SETTINGS.allowedServiceTypeIds,
      [],
      "a fresh install is restricted to service types that exist in no other org",
    );
  });

  it("survives a restart instead of being replaced by a hardcoded list", () => {
    // The hydration expression itself, read from source: it must pass an empty
    // list THROUGH. Booting the whole controller to assert this would need a
    // data dir, a settings file and the PCO client; the defect lives in one
    // expression, and that expression is what this reads.
    const src = fs.readFileSync(path.join(MAIN, "services", "stage-controller.ts"), "utf8");
    const code = stripLineComments(src);
    const hydration = code.match(/const allowedServiceTypeIds[^;]+;/s);
    assert.ok(hydration, "the hydration expression moved — this guard no longer reads anything");
    assert.ok(
      !/\.length\s*>\s*0/.test(hydration[0]),
      `an empty allowlist is still being treated as "unset" and replaced: ${hydration[0]}`,
    );
    assert.ok(
      !ID_ARRAY.test(hydration[0]),
      `the hydration still substitutes a hardcoded id list: ${hydration[0]}`,
    );
  });
});

/**
 * An array literal of two or more quoted digit strings — `["11111", "22222"]`.
 *
 * The shape, not the values. A guard written against the specific ids would go
 * green the moment somebody pasted a different org's, which is the leak all over
 * again.
 */
const ID_ARRAY = /\[\s*"\d{3,}"\s*(?:,\s*"\d{3,}"\s*)+,?\s*\]/;

/**
 * The same shape, global, for the whole-file scan below.
 *
 * `\s` already crosses newlines, so the pattern needs no change to see an array
 * the formatter has wrapped — only a scan that reads the whole file does.
 */
const ID_ARRAY_ALL = new RegExp(ID_ARRAY.source, "g");

/**
 * Full-line comments blanked, so prose about the bug cannot satisfy the scan.
 *
 * Blanked rather than deleted: the whole-file scan reports the line a match
 * starts on, and dropping lines would number every offender against a file that
 * does not exist on disk.
 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l))
    .join("\n");
}

/** Every .ts/.tsx under main/, tests excluded — a fixture may hold an id. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("no organisation's ids are baked into the source", () => {
  it("finds files at all, so a broken scan cannot pass silently", () => {
    assert.ok(sourceFiles(MAIN).length > 50, "the file walk found almost nothing");
  });

  it("has no hardcoded service-type id list anywhere under main/", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(MAIN)) {
      // WHOLE FILE, not line by line. This scan used to test each line on its
      // own, and oxfmt wraps an array literal once it passes the print width —
      // so whether this SECURITY guard fired came down to how long the pasted
      // ids happened to be. Four invented ids on one line were caught; the same
      // four wrapped across lines walked straight past it.
      const code = stripLineComments(fs.readFileSync(file, "utf8"));
      for (const m of code.matchAll(ID_ARRAY_ALL)) {
        const line = code.slice(0, m.index).split("\n").length;
        // Collapsed so a wrapped literal is reported as the one thing it is.
        offenders.push(`${path.relative(MAIN, file)}:${line}: ${m[0].replace(/\s+/g, " ")}`);
      }
    }
    // EXACT, not a floor. A floor with slack is how three of these survived.
    assert.deepEqual(offenders, [], "these lines hardcode a list of numeric ids");
  });
});
