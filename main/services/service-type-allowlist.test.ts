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
 * An array literal of numeric ids — `["11111", "22222"]`, `["11111"]`,
 * `[111111, 222222]`.
 *
 * The shape, not the values. A guard written against the specific ids would go
 * green the moment somebody pasted a different org's, which is the leak all over
 * again.
 *
 * Three shapes, because the version that required `(?:,\s*"\d{3,}"\s*)+` — two
 * or more, quoted — let a SINGLE pasted id through, and an unquoted one, and a
 * pasted response holds whichever the source happened to use.
 *
 * The thresholds differ because the false-positive risk does. A quoted digit
 * string is almost always an id, so three digits is enough. A bare number is
 * usually a pixel width, a font weight or a timeout — `[300, 400, 500]` appears
 * legitimately in this repo — so the unquoted arm asks for six, which every PCO
 * service-type id has and none of those do.
 */
const QUOTED_ID = String.raw`"\d{3,}"`;
const BARE_ID = String.raw`\d{6,}`;
const ID_ARRAY = new RegExp(
  String.raw`\[\s*(?:${QUOTED_ID}|${BARE_ID})\s*(?:,\s*(?:${QUOTED_ID}|${BARE_ID})\s*)*,?\s*\]`,
);

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

/**
 * Every shipped source root, so the scan cannot be stepped around by putting the
 * ids somewhere it does not look.
 *
 * It walked `main/` alone. `renderer/` is a sibling of it, not a child, so the
 * same array in a component was invisible — and so was every `.json` under
 * either, in the release that introduced JSON fixtures, which is the likeliest
 * place a pasted PCO response lands.
 */
const ROOTS = ["main", "renderer", "scripts"] as const;
const REPO = path.resolve(MAIN, "..");

/**
 * Every source or data file under a root.
 *
 * Every extension the repo actually ships, not just `.ts`/`.tsx`: `scripts/`
 * holds `.mjs` and `.mts`, one of them a PCO probe, which is precisely where a
 * response gets pasted while somebody is working something out.
 *
 * Code files exclude tests — they invent ids on purpose, and this repo's own
 * `["65533", "65534", "65535"]` is a battery reading. `.json` is NOT excluded,
 * fixtures included: a fixture is where a pasted response lands, and the
 * docstring here used to say so while the code filtered it out.
 */
const CODE = /\.(tsx?|mts|cts|mjs|cjs|jsx?)$/;
const CODE_TEST = /\.test\.(tsx?|mts|cts|mjs|cjs|jsx?)$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith(".json")) out.push(full);
    else if (CODE.test(entry.name) && !CODE_TEST.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every scanned file, across every root, plus the server entry point at the
 *  repo root — which no root contains and which is shipped. */
function scannedFiles(): string[] {
  return [
    ...ROOTS.flatMap((r) => sourceFiles(path.join(REPO, r))),
    path.join(REPO, "server.ts"),
  ];
}

describe("no organisation's ids are baked into the source", () => {
  it("walks every root, and every extension a pasted id can land in", () => {
    // Not a floor. `length > 50` was true of a walk that missed `renderer/`
    // entirely and every `.json` in the repo — the two places the leak was
    // proved to survive. What matters is not how many files it found but that it
    // found each KIND, so this asserts one of each, by name.
    const found = scannedFiles().map((f) => path.relative(REPO, f));
    for (const root of ROOTS) {
      assert.ok(
        found.some((f) => f.startsWith(`${root}${path.sep}`)),
        `the walk found nothing under ${root}/`,
      );
    }
    assert.ok(found.includes("server.ts"), "the walk missed the server entry point");
    assert.ok(
      found.some((f) => f.endsWith(".tsx")),
      "the walk found no .tsx — a renderer component is where the leak was proved to survive",
    );
    // EXACT. A .json fixture is the likeliest place a pasted PCO response lands,
    // so a new one is a moment to look at it rather than a number to nudge.
    assert.deepEqual(
      found.filter((f) => f.endsWith(".json")).sort(),
      [
        "main/services/fixtures/espn-football-in-play.json",
        // Both arrived with the midnight-carry and poll-tier fixes. Checked when
        // they were added to this list: every id in them is invented (700001,
        // 9101 and friends), the only long numbers are dates, and no real
        // organisation name appears.
        "main/services/fixtures/espn-late-slate.json",
        "main/services/fixtures/espn-mlb-doubleheader.json",
        "main/services/fixtures/espn-next-slate.json",
        "main/services/fixtures/espn-nfl-scoreboard.json",
        "main/services/fixtures/pvp-playlists.json",
        "main/services/fixtures/pvp-workspace.json",
        // Checked when it was added to this list: seven scope names and their
        // English words. The only digits in it are the 11 of a11y and the 18 of
        // i18n — nothing organisation-shaped, nothing pasted.
        "main/services/scope-labels.json",
        "main/tsconfig.json",
      ],
      "the set of scanned .json files changed — check the new one for pasted ids",
    );
  });

  it("has no hardcoded id list in any of them", () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      // WHOLE FILE, not line by line. This scan used to test each line on its
      // own, and oxfmt wraps an array literal once it passes the print width —
      // so whether this SECURITY guard fired came down to how long the pasted
      // ids happened to be. Four invented ids on one line were caught; the same
      // four wrapped across lines walked straight past it.
      const code = stripLineComments(fs.readFileSync(file, "utf8"));
      for (const m of code.matchAll(ID_ARRAY_ALL)) {
        const line = code.slice(0, m.index).split("\n").length;
        // Collapsed so a wrapped literal is reported as the one thing it is.
        offenders.push(`${path.relative(REPO, file)}:${line}: ${m[0].replace(/\s+/g, " ")}`);
      }
    }
    // EXACT, not a floor. A floor with slack is how three of these survived.
    assert.deepEqual(offenders, [], "these lines hardcode a list of numeric ids");
  });

  it("and the pattern sees each shape a pasted response can arrive in", () => {
    // The guard on the guard, on hand-written text rather than on the tree: the
    // three shapes that were PROVED to leave the suite at 4 pass / 0 fail.
    for (const shape of [
      '{"allowedServiceTypeIds":["1111111","2222222","3333333","4444444"]}',
      'const ids = ["1111111", "2222222"];',
      'const one = ["9999999"];',
      "const bare = [9999998, 9999997];",
      "const wrapped = [\n  9999998,\n  9999997,\n];",
    ]) {
      assert.match(shape, ID_ARRAY, `the scan cannot see this shape: ${shape}`);
    }
    // And it does not fire on the numbers this repo legitimately holds.
    for (const innocent of ["[300, 400, 500, 600]", "[1920, 2176]", "[100]", '["ab", "cd"]']) {
      assert.doesNotMatch(innocent, ID_ARRAY, `false positive on ${innocent}`);
    }
  });
});
