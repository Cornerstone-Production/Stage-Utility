// The Scores card's height budget at its smallest tile.
//
// ── What this can and cannot prove ───────────────────────────────────────────
//
// It CANNOT prove the thing that was reported. The bug was visual: on a Medium
// tile the second team's chip read as a circle with its bottom sliced off. The
// circle was never truncated — its 24 rows and its bottom arc are pixel-for-
// pixel the same before and after the fix. What was wrong is that the card was
// four pixels over its own budget, `min-height: 0` made the list the box flex
// took the four from, the last row hung out below the list, and the venue rule
// — which mt-auto pins to the bottom of the card — landed on the pixel row
// IMMEDIATELY after the chip's last arc pixel. A full-width solid rule butted
// flush against the bottom of a circle reads as the circle being cut. Nothing
// in JS can see that, and jsdom has no layout, so no test here asserts it. It
// was verified in a browser, at Small, Medium, Large, Extra large and Tall, in
// both themes.
//
// What this CAN prove is the arithmetic underneath it: that the caption, one
// matchup and the venue add up to less than a 120px tile holds, with room to
// spare rather than the zero the bug had. Every number is read out of the real
// stylesheet with a real CSS parser — postcss Declaration nodes, so a comment
// naming a property cannot satisfy any of it — or off a class the real element
// actually carries.
//
// The model is not guessed. It was validated against the running app: it
// predicts 94px of content box and 91px of content, and a browser measured
// exactly 94 and 91 on the shipped build.
//
// ── It goes red on each piece of the fix ─────────────────────────────────────
//
//   put `min-height: 0` back on .home-scores-list   → the min-height test fails
//   delete `line-height: 1` from .home-scores-value → needed becomes 94, not 91
//   put back mt-1.5 OR pt-1.5 in cards.tsx          → needed becomes 93
//   put back BOTH                                   → needed becomes 95
//   grow the chip past 24px, or move ROW_PX         → both totals move
//
// Every row above was run. The totals are asserted EXACTLY, not as a floor: a
// floor with slack is how a card ends up back at zero clearance one restyle at
// a time, and an exact number makes whoever changes the type or the padding
// re-derive the budget and go look at the card, which is the only place the
// visual claim can actually be checked.
//
// There are three tests and not six on purpose. The clearance is just
// budget - needed, and the score's line box is an input to `needed`, so asserting
// either separately would be one subtraction restated — a test that cannot fail
// on its own. `contentNeeded` reports its breakdown in the failure message
// instead, which is what naming the cause was worth.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import postcss from "postcss";

const CSS = postcss.parse(readFileSync(new URL("../../styles.css", import.meta.url), "utf8"));
const CARDS = readFileSync(new URL("./cards.tsx", import.meta.url), "utf8");
const GRID = readFileSync(new URL("./home-grid.tsx", import.meta.url), "utf8");

/**
 * Every declaration on a selector, last one winning.
 *
 * Declaration NODES only. postcss models a comment as a Comment node, so the
 * long note above `.home-scores-list` — which spells out `min-height: 0` twice
 * in prose — cannot make the min-height assertion pass.
 *
 * Known limit: at-rule context is flattened. A rule inside `@container` or
 * `@media` is merged in as if it applied everywhere, in document order rather
 * than by cascade. That is deliberate for the min-height guard, which should
 * catch the property wherever it is hidden. It would be wrong for a future
 * `@container` override of, say, the row's padding: this would model it as
 * applying at every tile size. Nothing in this card does that today, and the
 * exact totals below are what would fail if something started to.
 */
function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  let seen = false;
  CSS.walkRules((rule) => {
    if (!rule.selector.split(",").map((s) => s.trim()).includes(selector)) return;
    seen = true;
    rule.each((node) => {
      if (node.type === "decl") found.set(node.prop, node.value);
    });
  });
  assert.ok(seen, `no rule in styles.css declares ${selector}`);
  return found;
}

/**
 * The leading px length of a declared value, asserting it really is one.
 *
 * ONE parser for every length this file reads, so `padding: 2px 0` and
 * `border-top: 1px solid …` and a bare `24px` all fail the same way. Parsing a
 * value inline was how a `border-top: thin solid` would have made the whole
 * budget NaN and failed with a total rather than a cause.
 */
function pxOf(raw: string | undefined, what: string): number {
  assert.ok(raw !== undefined, `${what} is not declared`);
  const head = raw.trim().split(/\s+/)[0]!;
  assert.ok(head.endsWith("px"), `${what} is not a px length: ${raw}`);
  const n = Number.parseFloat(head);
  assert.ok(Number.isFinite(n), `${what} is not a number: ${raw}`);
  return n;
}

function px(selector: string, prop: string): number {
  return pxOf(declarations(selector).get(prop), `${selector} ${prop}`);
}

/**
 * The line box a span makes.
 *
 * A `line-height` this card does not declare inherits the page's, which Tailwind
 * preflight sets to 1.5 on `html` — measured in the browser as the 25.5px box a
 * 17px score made before it was pinned. That fallback is the whole point: delete
 * the declaration and the arithmetic goes back to what was broken.
 */
const INHERITED_LINE_HEIGHT = 1.5;
function lineBox(selector: string): number {
  const d = declarations(selector);
  const size = pxOf(d.get("font-size"), `${selector} font-size`);
  const lh = d.get("line-height");
  if (lh === undefined) return size * INHERITED_LINE_HEIGHT;
  return lh.trim().endsWith("px") ? Number.parseFloat(lh) : size * Number.parseFloat(lh);
}

/**
 * A Tailwind spacing step on a class the card actually carries. 1 -> 4px.
 *
 * `(?<![\w-])` / `(?![\w-])` rather than `\b`: a hyphen is a word boundary, so
 * `\bhome-scores\b` matches inside `home-scores-list` and this would read the
 * list's margin as the section's padding.
 */
function spacing(className: string, utility: "mt" | "pt" | "py"): number {
  const m = new RegExp(`className="[^"]*(?<![\\w-])${className}(?![\\w-])[^"]*"`).exec(CARDS);
  assert.ok(m, `no element in cards.tsx carries ${className}`);
  const step = new RegExp(`\\b${utility}-(\\d+(?:\\.\\d+)?)\\b`).exec(m[0]);
  assert.ok(step, `${className} carries no ${utility}- utility: ${m[0]}`);
  return Number.parseFloat(step[1]!) * 4;
}

/**
 * The classes on the caption's status span — the "Top 2nd" / "8/30 - 1:40 PM
 * EDT" half of the header.
 *
 * Its own className, not the section's, so it needs the `cn(` call rather than a
 * `className="…"` literal. Anchored INSIDE ScoresCard and cut at the value the
 * span renders, so the tokens have to be on THIS element.
 *
 * Two traps here, both hit while writing it and both caught only by deleting the
 * class and watching what happened:
 *
 *  - `CARDS.indexOf("<h2")` found the first heading in a 900-line file —
 *    CheckRow's, hundreds of lines above — swept up a `truncate` belonging to
 *    something else, and stayed green with the class gone. Hence the anchor on
 *    ScoresCard itself.
 *  - The comment that now sits inside this very className quotes "Top 2nd" and
 *    a date. Quoted PROSE was being read as class tokens, so a comment
 *    containing the word could have satisfied the assertion — the exact way this
 *    repo has shipped a vacuous guard before. Hence the strip, and the check
 *    that the strip did not eat the code with it.
 *
 * A source match, and deliberately: the class list is a static string, so
 * rendering the component would only read the same literal back through `cn`,
 * which cannot drop a constant. What it would add is nothing; what it would cost
 * is the whole jsdom render harness in a file that otherwise needs no DOM.
 */
function captionStatusClasses(): string {
  const card = CARDS.slice(CARDS.indexOf("export function ScoresCard"));
  const end = card.indexOf("{featured.shortDetail}");
  assert.ok(end > 0, "ScoresCard no longer renders featured.shortDetail");
  const call = card
    .slice(card.indexOf("cn(", card.indexOf("<h2")), end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  // A strip that swallows the code it was meant to clean is how a scan goes
  // green on nothing at all. The call has to survive it.
  assert.ok(call.startsWith("cn("), "comment strip ate the cn( call");
  assert.match(call, /"ml-auto/, "comment strip ate the caption's class list");
  return [...call.matchAll(/"([^"]*)"/g)].map((m) => m[1]!).join(" ");
}

/** One grid row, from the assignment in home-grid.tsx. */
function rowPx(): number {
  const m = /export const ROW_PX = (\d+);/.exec(GRID);
  assert.ok(m, "home-grid.tsx no longer assigns ROW_PX");
  return Number.parseInt(m[1]!, 10);
}

/**
 * The hairline CardFrame draws, top and bottom, inside the tile — preflight
 * makes every box border-box, so a 120px tile hands the section 118.
 *
 * READ, not assumed. This was a hard-coded 1, which would have stayed 1 while
 * `border` became `border-2` and the card went two pixels over with the guard
 * still green — the exact shape of a check that passes on the defect it exists
 * to catch.
 */
function frameBorder(): number {
  const body = GRID.slice(GRID.indexOf("export function CardFrame"));
  const m = /className="([^"]*)"/.exec(body);
  assert.ok(m, "CardFrame in home-grid.tsx carries no className");
  const width = /(?<![\w-])border(?:-(\d+))?(?![\w-])/.exec(m[1]!);
  assert.ok(width, `CardFrame draws no border utility: ${m[1]}`);
  return width[1] === undefined ? 1 : Number.parseInt(width[1], 10);
}

/** What a Medium (1-row) tile leaves inside the card's own padding. */
function contentBudget(): number {
  return rowPx() - 2 * frameBorder() - 2 * spacing("home-scores", "py");
}

/** Caption + one matchup + venue, the way the browser stacks them. */
function contentNeeded(): { total: number; parts: Record<string, number> } {
  // align-items: center on the row, so the row is as tall as its tallest part.
  // The chip is a fixed square; the name and the score are line boxes.
  const row =
    Math.max(px(".home-scores-chip", "height"), lineBox(".home-scores-name"), lineBox(".home-scores-value")) +
    2 * pxOf(declarations(".home-scores-row").get("padding"), ".home-scores-row padding");
  const parts = {
    caption: lineBox(".text-caption2"),
    listMargin: spacing("home-scores-list", "mt"),
    // Two teams, and no gap between them: the list's own gap separates
    // MATCHUPS, and a Medium tile shows one.
    matchup: 2 * row,
    venuePadding: spacing("home-scores-foot", "pt"),
    venueRule: pxOf(declarations(".home-scores-foot").get("border-top"), ".home-scores-foot border-top"),
    venueText: lineBox(".text-caption2"),
  };
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}

describe("the Scores card fits its smallest tile", () => {
  test("a Medium tile leaves 94px inside the card", () => {
    assert.equal(
      contentBudget(),
      94,
      `${rowPx()}px tile, less ${frameBorder()}px of frame and ${spacing("home-scores", "py")}px of padding each side`,
    );
  });

  test("caption, one matchup and the venue come to 91px, three inside the budget", () => {
    // 91 in 94. It was 98 in 94 — four over, and `min-height: 0` handed the four
    // to the list, which is how the venue rule ended up flush against a chip.
    // Zero spare here IS the bug; the browser reads those three as five clear
    // pixels between the chip's edge and the rule, the row's padding included.
    const { total, parts } = contentNeeded();
    assert.equal(total, 91, `budget ${contentBudget()}, needed ${total}: ${JSON.stringify(parts)}`);
  });

  test("the caption cannot wrap to a second line", () => {
    // The budget counts ONE caption line. shortDetail is untruncated ESPN text
    // that falls back to the longer `detail`, so a game that has not started
    // reads "8/30 - 1:40 PM EDT"; on a Small tile at a narrow Home that wrapped,
    // put a second 13px line into a card with 3px spare, and the venue -- the
    // only box left that can give -- came out sliced through its glyphs.
    // Measured at 560px: header 26px, venue clipped by 10.
    const classes = captionStatusClasses();
    assert.ok(
      classes.includes("truncate"),
      `the caption's status text must not wrap; it carries: ${classes}`,
    );
    assert.ok(
      classes.includes("min-w-0"),
      `truncate does nothing on a flex item that will not shrink; it carries: ${classes}`,
    );
  });

  test("the list cannot be shrunk below the rows it was given", () => {
    // The list IS the card's content, and which matchups are in it is already
    // decided by the container queries on the grounds that a row must be whole
    // or absent. min-height: 0 let flex undo that decision after the fact.
    assert.equal(
      declarations(".home-scores-list").get("min-height"),
      undefined,
      "min-height on .home-scores-list makes it the box flex shrinks; leave it at auto",
    );
  });
});
