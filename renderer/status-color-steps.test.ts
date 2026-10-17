// A status colour step that does not exist is dropped without a word.
//
// styles.css defines the semantic status colours at two steps only: 9 (a fill)
// and 11 (text). Tailwind generates no utility for `bg-warn-2`, and a CSS
// variable the stylesheet never declares resolves to nothing, so both compile and
// ship: the class is simply not there. The /patch page's amber "changes" card
// carried `border-warn-6 bg-warn-2/40` that way for as long as it existed, and
// rendered with a black border and no tint on every theme.
//
// The class names are read as written and checked against what the stylesheet
// declares, so a step added to the theme is accepted and a step nobody declared
// is not. Comments are blanked first: a comment naming `bg-warn-2` neither fails
// this nor satisfies it.
//
// Proven red in the session that wrote it: with the eight offenders below still in
// the source it reported all eight, and each fix took exactly its own line off.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { withoutComments } from "./source-comments.js";

const ROOT = new URL("./", import.meta.url).pathname;
const CSS = readFileSync(join(ROOT, "styles.css"), "utf8");

const FAMILIES = ["live", "danger", "warn", "ok", "info"];
const FAMILY = FAMILIES.join("|");

/** Every .ts/.tsx under renderer/, walked, tests excluded (they quote bad names on purpose). */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** `warn-9`, `ok-11`: the steps the theme declares as a colour utility. */
const declaredSteps = new Set([...CSS.matchAll(new RegExp(`--color-((?:${FAMILY})-\\d+)\\s*:`, "g"))].map((m) => m[1]));
/** `--live-9`: raw variables the stylesheet declares, for `var(--x)` references. */
const declaredVars = new Set([...CSS.matchAll(/(--[a-z]+-\d+)\s*:/g)].map((m) => m[1]));

describe("status colour steps", () => {
  test("the theme declares some, so the scan below is not checking against nothing", () => {
    assert.ok(declaredSteps.has("warn-9") && declaredSteps.has("warn-11"), [...declaredSteps].join(", "));
    assert.ok(declaredVars.has("--live-9"), "the raw variable pattern found nothing");
  });

  test("every status colour utility and variable a component names is declared", () => {
    const offenders: string[] = [];
    for (const file of sources(ROOT)) {
      const src = withoutComments(readFileSync(file, "utf8"));
      const at = file.replace(ROOT, "");
      for (const m of src.matchAll(new RegExp(`\\b[a-z]+-((?:${FAMILY})-\\d+)(?:/\\d+)?`, "g"))) {
        if (!declaredSteps.has(m[1])) offenders.push(`${at}: ${m[0]}`);
      }
      for (const m of src.matchAll(new RegExp(`var\\((--(?:${FAMILY})-\\d+)\\)`, "g"))) {
        if (!declaredVars.has(m[1])) offenders.push(`${at}: var(${m[1]})`);
      }
    }
    assert.deepEqual(offenders.sort(), [], "a step the theme never declared is silently not applied");
  });
});
