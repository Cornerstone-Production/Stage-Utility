// The page gutter is applied ONCE, by the shell.
//
// It used to be applied by each route, and the routes added most recently did
// not, so the editor and Screens sat flush against the right edge. Moving it to
// <main> fixed those and silently DOUBLED it everywhere a section still padded
// itself: ten roots, all of them rendered inside <main>, each inset 40px while
// the pages beside them read 20. On Home the two were visible in the same
// scroll — its Plan card sat 20px further in than its readiness card.
//
// So this asserts an EXACT set of files, not a ceiling. A floor with slack is
// how the first pass shipped having fixed three of thirteen.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The gutter itself. Matched as the literal pair, since either half alone is a
 * different decision — a page may want horizontal padding that is not this.
 *
 * Known limit: a reordered or interleaved class list ("max-sm:px-3 px-5") would
 * slip past. Accepted, because this catches the mistake that actually happened —
 * copy-pasting the pair — and a class-list parser here would be a worse thing to
 * maintain than the bug it prevents.
 */
const GUTTER = "px-5 max-sm:px-3";

/**
 * Every file allowed to carry it, and why.
 *
 * Both live OUTSIDE <main>: the shell's own header and the context bar are
 * siblings of the scroll container, so they get no padding from it. Anything
 * else in this list is a bug — a route inside <main> that pads itself doubles.
 */
const ALLOWED = new Set([
  "app/shell.tsx",
  "app/context-bar.tsx",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("page gutter", () => {
  test("only the shell applies it", () => {
    const found = walk(RENDERER)
      .filter((f) => readFileSync(f, "utf8").includes(GUTTER))
      .map((f) => relative(RENDERER, f).split("\\").join("/"))
      .sort();

    assert.deepEqual(
      found,
      [...ALLOWED].sort(),
      "a file inside <main> pads itself, so its page is inset twice — remove the local " +
        `"${GUTTER}" and let the shell apply it, or add the file here with the reason it sits outside <main>`,
    );
  });
});
