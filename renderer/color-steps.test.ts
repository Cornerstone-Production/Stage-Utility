// A colour step that does not exist is dropped without a word.
//
// Tailwind generates no utility for `bg-warn-2`, `border-red-a6` or
// `text-accent-11` unless the theme declares that step, and a CSS variable the
// stylesheet never declares resolves to nothing. Both compile and ship: the class
// is simply not there, and the element renders with a default border and no
// tint, or with a fallback nobody chose.
//
// A class is declared when Tailwind's own compiler emits a rule for it, and a
// variable when a stylesheet the compiler loaded declares it, comments excluded.
// A name only counts if its prefix is a real colour utility, so `row-ok-2` as a
// test id is not a colour class.
//
// Scope: classes written out in full with a numbered step (`bg-${tone}-3` and
// `text-warn` are not seen), and variables whose name ends in a step. A variable
// the code assigns at runtime is not declared by a stylesheet; give it a name that
// does not end in a step. Comments in the scanned sources are blanked first, so
// one naming `bg-warn-2` neither fails this nor satisfies it.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { compile } from "tailwindcss";

import { withoutComments } from "./source-comments.js";

const ROOT = new URL("./", import.meta.url).pathname;
const NODE_MODULES = join(ROOT, "..", "node_modules");

/** Every stylesheet the theme pulls in, comments blanked: a comment is not a declaration. */
const sheets: string[] = [];
const uncommented = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const compiler = await compile(readFileSync(join(ROOT, "styles.css"), "utf8"), {
  base: ROOT,
  loadStylesheet: async (id, base) => {
    const path = id.startsWith(".") ? join(base, id) : id === "tailwindcss" ? join(NODE_MODULES, "tailwindcss", "index.css") : join(NODE_MODULES, id);
    const content = readFileSync(path, "utf8");
    sheets.push(uncommented(content));
    return { path, base: dirname(path), content };
  },
});
sheets.push(uncommented(readFileSync(join(ROOT, "styles.css"), "utf8")));

/** Every colour family a stylesheet names through `--color-<family>-…`: `red`, `warn`, `accent`, `slate`. */
const familiesIn = (css: string): string[] => [...css.matchAll(/--color-([a-z]+)-/g)].map((m) => m[1]);
/** Every custom property a stylesheet declares, `--red-a6` and `--su-warn-9` alike. */
const declaredVarsIn = (css: string): string[] => [...uncommented(css).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);

const FAMILIES = new Set(sheets.flatMap(familiesIn));
const DECLARED_VARS = new Set(sheets.flatMap(declaredVarsIn));

/** `border-red-a6`, `hover:` stripped off: a prefix, a family, a step, an optional opacity. */
const COLOR_CLASS = new RegExp(`(?<![\\w-])((?:[a-z]+-)+?)((?:${[...FAMILIES].join("|")})-a?\\d+(?:/\\d+)?)(?![\\w-])`, "g");
/** `var(--red-a6`, `bg-(--red-a6)`, `bg-[--red-a6]`: a variable whose name ends in a step. */
const STEP_VAR = /(?:var\(|[([])\s*(--(?:[a-z]+-)+a?\d+)\s*[,)\]]/g;

/** The `.class` rule Tailwind wrote for `name`; the ` {` keeps `text-accent` from matching `text-accent-hover`. */
const emits = (css: string, name: string): boolean => css.includes(`.${name.replace("/", "\\/")} {`);

/** Every colour class and step variable `src` names that the theme never declared. */
function offendersIn(src: string, at: string): string[] {
  const code = withoutComments(src);
  const classes = [...code.matchAll(COLOR_CLASS)].map((m) => ({ name: m[1] + m[2], probe: `${m[1]}red-6` }));
  const css = compiler.build([...new Set(classes.flatMap((c) => [c.name, c.probe]))]);
  // The probe separates a missing step from a name that was never a colour class.
  const out = classes.filter((c) => !emits(css, c.name) && emits(css, c.probe)).map((c) => `${at}: ${c.name}`);
  for (const m of code.matchAll(STEP_VAR)) if (!DECLARED_VARS.has(m[1])) out.push(`${at}: var(${m[1]})`);
  return [...new Set(out)];
}

/** Every .ts/.tsx/.css under renderer/, walked, tests excluded (they quote bad names on purpose). */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("colour steps", () => {
  test("the theme declares some, so the scan below is not checking against nothing", () => {
    const names = ["bg-warn-9", "text-accent", "bg-red-6", "bg-live-9/12"];
    const css = compiler.build(names);
    for (const c of names) assert.ok(emits(css, c), `${c} did not compile`);
    assert.ok(FAMILIES.has("warn") && FAMILIES.has("red") && FAMILIES.has("accent"), [...FAMILIES].join(", "));
    assert.ok(DECLARED_VARS.has("--live-9") && DECLARED_VARS.has("--su-warn-9") && DECLARED_VARS.has("--red-6"), "the variable pattern found nothing");
  });

  test("a comment in a stylesheet does not declare a variable", () => {
    assert.deepEqual(declaredVarsIn("/* was --su-accent-9: #fff */ :root { --su-accent: red; }"), ["--su-accent"]);
  });

  test("the scan reports the steps nobody declared, and only those", () => {
    // The status families declare 9 and 11; red and green declare no alpha steps;
    // accent declares none at all.
    const bad = [
      'className="border-red-a6 bg-red-a3 hover:text-accent-12 bg-warn-2/40 text-green-a5 bg-red-a3"',
      "box-shadow: 0 0 0 3px var(--su-accent-9, #2e6691); color: var(--red-a6); outline: var(--su-accent-9);",
      'className="bg-(--green-a3) bg-[--green-a4]"',
    ].join("\n");
    const good = [
      'className="border-danger-9/30 bg-danger-9/12 text-accent hover:text-accent-hover bg-red-6 bg-amber-a2"',
      '/* bg-warn-2 */ var(--red-6) data-testid="row-ok-2" key="go-live-1"',
    ].join("\n");
    assert.deepEqual(offendersIn(bad, "x").sort(), [
      "x: bg-red-a3",
      "x: bg-warn-2/40",
      "x: border-red-a6",
      "x: text-accent-12",
      "x: text-green-a5",
      "x: var(--green-a3)",
      "x: var(--green-a4)",
      "x: var(--red-a6)",
      "x: var(--su-accent-9)",
    ]);
    assert.deepEqual(offendersIn(good, "x"), []);
  });

  test("every colour utility and step variable the renderer names is declared", () => {
    const offenders: string[] = [];
    for (const file of sources(ROOT)) offenders.push(...offendersIn(readFileSync(file, "utf8"), file.replace(ROOT, "")));
    assert.deepEqual(offenders.sort(), [], "a step the theme never declared is silently not applied");
  });
});
