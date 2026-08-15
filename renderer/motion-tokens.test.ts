import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Motion is a system or it is noise. This checks the two ways it stops being one:
// a hard-coded duration that quietly disagrees with the tokens, and a token that
// exists in the stylesheet but reaches nothing.
//
// It matches on DECLARATIONS, never on prose. A comment saying "uses the motion
// tokens" cannot satisfy any assertion here.

const ROOT = new URL("./", import.meta.url).pathname;
const CSS = readFileSync(join(ROOT, "styles.css"), "utf8");

/** Every .ts/.tsx under renderer/, walked - not a hand-listed set of files. */
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

const FILES = sources(ROOT);

describe("the tokens exist and are the whole set", () => {
  for (const token of ["--motion-instant", "--motion-quick", "--motion-settled"]) {
    test(`${token} is defined`, () => {
      assert.match(CSS, new RegExp(`${token}:\\s*\\d`), `${token} must have a real value`);
    });
  }

  test("there are exactly three durations", () => {
    // An exact count. Nine durations is a system nobody applies consistently,
    // and the way you get nine is by adding a fourth "just this once".
    const defs = CSS.match(/--motion-(instant|quick|settled|[a-z-]+):\s*\d+m?s/g) ?? [];
    assert.equal(defs.length, 3, `expected 3 duration tokens, found: ${defs.join(", ")}`);
  });

  test("Tailwind's default transition resolves to a token", () => {
    // This is what makes the tokens reach ~86 bare `transition-*` utilities
    // without 51 files having to remember anything.
    assert.match(CSS, /--default-transition-duration:\s*var\(--motion-quick\)/);
    assert.match(CSS, /--default-transition-timing-function:\s*var\(--motion-ease\)/);
  });
});

describe("nothing hard-codes a duration", () => {
  test("no literal Tailwind duration utility survives", () => {
    // `duration-150` is the shape this catches: a number rather than a token.
    // `duration-(--motion-quick)` passes; `duration-[150ms]` and `duration-700`
    // do not.
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bduration-(\[?\d+m?s?\]?)/g)) {
        offenders.push(`${f.replace(ROOT, "")}: duration-${m[1]}`);
      }
    }
    assert.deepEqual(offenders, [], "use duration-(--motion-*) instead of a literal");
  });

  test("no inline transition-duration with a literal value", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/transitionDuration:\s*["'`]\s*\d+m?s/g)) {
        offenders.push(`${f.replace(ROOT, "")}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [], "inline durations must reference a token");
  });
});

describe("every token is actually used", () => {
  // Tailwind v4 tree-shakes theme variables nothing references, so a token that
  // reaches no component is not merely unused - it is ABSENT from the built CSS.
  // This was real: --motion-instant resolved to "" in the browser until hover and
  // press were moved onto it.
  for (const token of ["--motion-instant", "--motion-quick", "--motion-settled"]) {
    test(`${token} reaches at least one component`, () => {
      const used =
        FILES.some((f) => readFileSync(f, "utf8").includes(`(${token})`)) ||
        // --motion-quick reaches components through Tailwind's default rather
        // than by name, which is the point of wiring it there.
        (token === "--motion-quick" && /--default-transition-duration:\s*var\(--motion-quick\)/.test(CSS));
      assert.ok(used, `${token} is defined but nothing uses it, so it is tree-shaken away`);
    });
  }
});

describe("reduced motion is honoured once, globally", () => {
  test("a reduced-motion block collapses transitions and animations", () => {
    assert.match(CSS, /prefers-reduced-motion:\s*reduce/);
    assert.match(CSS, /transition-duration:\s*1ms\s*!important/);
    assert.match(CSS, /animation-duration:\s*1ms\s*!important/);
  });

  test("the spinner keeps turning", () => {
    // "Still working" is information. A frozen spinner reads as a hung app, so
    // reduced motion slows it rather than stopping it.
    assert.match(CSS, /\.animate-spin\s*\{[^}]*animation-iteration-count:\s*infinite/);
  });
});
