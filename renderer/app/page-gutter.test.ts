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
//
// Two other places have to MIRROR the shell's number, and a number nobody checks
// drifts: the full-bleed routes cancel it with negative margins, and the context
// strip insets its title by it in CSS. Both are asserted against the one gutter
// declared below, so changing it fails here until they follow.

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
const GUTTER = "px-2 max-sm:px-3";

/** The same pair, negated: what a route that fills the content area edge to edge puts
 *  on its root so it is not inset by the shell. Derived, never typed, so it cannot
 *  disagree with GUTTER. */
const CANCEL = GUTTER.replaceAll("px-", "-mx-");

/** Tailwind's spacing step is 4px, so `px-2` is 8px and `px-3` is 12px. */
function px(utility: string): number {
  const step = /-(\d+)$/.exec(utility);
  assert.ok(step, `cannot read a spacing step from "${utility}"`);
  return Number(step[1]) * 4;
}

/**
 * Every file allowed to carry it, and why.
 *
 * The shell's own header lives OUTSIDE <main> — it is a sibling of the scroll
 * container, so it gets no padding from it. Anything else in this list is a bug:
 * a route inside <main> that pads itself doubles.
 *
 * The context bar was the second entry and is not any more. It sits outside
 * <main> too and still carries the same gutter, but it declares it in CSS rather
 * than in utilities, because its fit ladder tightens the edge padding at level 2
 * and a rung that has to out-specify a Tailwind class to do it stops working the
 * first time somebody reorders the class list. See `.context-strip`.
 */
const ALLOWED = new Set([
  "app/shell.tsx",
]);

/**
 * Every file that fills the content area edge to edge by cancelling the gutter.
 * Both are routes inside <main>: the console and the ServiceCue rundown. A third
 * that cancels it with a different number sits inset or overshoots, and is found
 * here by the exact negated pair.
 */
const CANCELLERS = new Set([
  "app/console-route.tsx",
  "main/servicecue-plan-view.tsx",
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

  test("exactly the full-bleed routes cancel it, with the negated pair", () => {
    const found = walk(RENDERER)
      .filter((f) => readFileSync(f, "utf8").includes(CANCEL))
      .map((f) => relative(RENDERER, f).split("\\").join("/"))
      .sort();

    assert.deepEqual(
      found,
      [...CANCELLERS].sort(),
      `a route that fills the content area must cancel the shell's gutter with exactly "${CANCEL}"`,
    );
  });

  test("the context strip insets by the same amount, at both widths", () => {
    // The strip sits OUTSIDE <main>, so it cannot inherit the gutter and declares
    // its own in CSS. It is the title's left edge: out of step with the content
    // below it, the page name sits visibly off the column it heads.
    const css = readFileSync(join(RENDERER, "styles.css"), "utf8");
    const [wide, phone] = GUTTER.split(" ").map(px);

    const rule = /(?:^|\n)\.context-strip \{([^}]*)\}/.exec(css);
    assert.ok(rule, "the .context-strip rule is gone");
    assert.match(rule[1], new RegExp(`padding-inline: ${wide}px;`), `the strip's edge padding is not the gutter (${wide}px)`);

    const narrow = /@media \(max-width: 639px\) \{\s*\.context-strip \{([^}]*)\}/.exec(css);
    assert.ok(narrow, "the phone .context-strip rule is gone");
    assert.match(narrow[1], new RegExp(`padding-inline: ${phone}px;`), `the strip's phone edge padding is not the gutter (${phone}px)`);
  });
});
