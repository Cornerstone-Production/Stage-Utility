// score-activity.test.tsx — the rules the score panel obeys about opening and
// closing itself, and about what the bar shows when there is nothing live.
//
// WHAT IS DELIBERATELY NOT GUARDED HERE, and why a test for it would be worse
// than no test:
//
//   1. THE COLOUR MASK LIVING ON THE ::before LAYER RATHER THAN ON THE ELEMENT.
//      jsdom loads no stylesheet, so getComputedStyle returns Tailwind's
//      defaults for everything in styles.css and `maskImage` reads "" whether
//      the rule is on `.score-side` or on `.score-side::before`. A test
//      asserting it would pass with the mask moved back onto the element —
//      which is the exact bug it would claim to catch, and the one that made
//      the scores unreadable near the seam.
//
//   2. THE STACK'S HEIGHTS AS A BROWSER MEASURES THEM. Every offsetHeight in
//      jsdom is 0, so a test that RENDERED the stack and asserted the cards do
//      not overlap would pass while they all sat on top of each other.
//
//      Its ARITHMETIC is a different question and is guarded, at the bottom of
//      this file. layoutStack is pure and takes its elements as a parameter, so
//      the heights can be stubbed the way page-scroll-reset.test.tsx stubs
//      scrollTop — and the bug was a measurement-SOURCE error, which is exactly
//      what a stub can tell apart: the body reports its natural height and the
//      grid item around it reports the 0 it is leaving.
//
// The rendered geometry is verified in a real browser instead, against the
// checklist in Task 5 step 7 of docs/superpowers/plans/2026-08-29-live-scores.md.
// What IS guarded here is everything that is pure logic and therefore cannot lie
// to jsdom: the hold timer, the rev guard, the seed, the stack arithmetic, and
// which of four things the bar says.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, mock, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { createScoreActivity, SCORE_HOLD_MS, scoreActivity } =
  await import("./score-activity-store.js");
const { ScoreActivityHost, ScoreCapsule, capsuleView, layoutStack, liveIndex, scoredSide } =
  await import("./score-activity.js");
// The app's own contrast maths, not a second copy: raising or lowering what
// color-math computes must move what this file measures.
const { contrastRatio, formatColor, parseColor } = await import("../components/ui/color-math.js");

// Unconditional, not a call at the end of each test body: a test that FAILS
// never reaches its own cleanup, and proving these guards against the bug is
// exactly when they fail on purpose.
afterEach(() => cleanup());

after(() => {
  teardown();
});

const TEAM = (id: string, score: number | null): ScoreTeamDTO => ({
  id,
  abbreviation: id === "16" ? "CHC" : "CIN",
  name: id === "16" ? "Cubs" : "Reds",
  displayName: id === "16" ? "Chicago Cubs" : "Cincinnati Reds",
  color: id === "16" ? "#0e3386" : "#c6011f",
  logo: null,
  record: null,
  score,
});

function game(over: Partial<ScoreGameDTO> = {}): ScoreGameDTO {
  return {
    eventId: "e1",
    league: "mlb",
    sport: "baseball",
    state: "in",
    delayed: false,
    detail: "Top 3rd",
    shortDetail: "Top 3rd",
    clock: "",
    startsAt: "2026-08-14T18:05:00.000Z",
    venue: "Wrigley Field",
    away: TEAM("17", 2),
    home: TEAM("16", 6),
    situation: null,
    ...over,
  };
}

function status(over: Partial<ScoresStatusDTO> = {}): ScoresStatusDTO {
  return {
    connected: true,
    games: [game()],
    scoreRev: 0,
    lastEvents: [],
    fetchedAt: "2026-08-14T18:30:00.000Z",
    error: null,
    ...over,
  };
}

// Each test gets its OWN store. Module state cannot be returned to "never
// touched", which is precisely the condition all three of these rules are about,
// and tests that only pass in the order they were written are not guards.
describe("the panel opens itself once per score, and lets go when told", () => {
  test("one score opens it once", () => {
    const s = createScoreActivity();
    s.scored(5, 0);
    assert.equal(s.get().open, true);
    assert.equal(s.get().seenRev, 5);

    // THE GUARD. The DTO is re-delivered to every late SSE subscriber from the
    // hello burst, so without the rev check a page opened five minutes after a
    // touchdown pops the panel as if it had just happened -- and a panel the
    // operator closed re-opens on the next unrelated frame carrying the same
    // rev.
    s.close();
    s.scored(5, 0);
    assert.equal(s.get().open, false, "a rev already seen re-opened the panel");
  });

  test("a hand-driven toggle cancels the hold", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const s = createScoreActivity();
      s.scored(1, 0);
      assert.equal(s.get().open, true);

      // The operator opens it by hand. From this moment the panel is THEIRS.
      s.toggle();
      assert.equal(s.get().open, false);
      s.toggle();
      assert.equal(s.get().open, true);

      // THE GUARD. Without clearHold() in toggle, the score's 6.5s timer is
      // still running and folds the panel away under an operator who opened it
      // deliberately -- a dismissal undone by a countdown they cannot see.
      mock.timers.tick(SCORE_HOLD_MS + 500);
      assert.equal(s.get().open, true, "a timer left over from a score closed a hand-opened panel");
    } finally {
      mock.timers.reset();
    }
  });

  test("the hold still folds an AUTO-opened panel away", () => {
    // The other half of the rule above: cancelling on a hand-driven open must
    // not have cancelled the hold for everyone.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const s = createScoreActivity();
      s.scored(1, 0);
      mock.timers.tick(SCORE_HOLD_MS + 1);
      assert.equal(s.get().open, false, "an auto-opened panel never folded away");
    } finally {
      mock.timers.reset();
    }
  });

  test("seed marks a rev as seen without opening anything", () => {
    const s = createScoreActivity();

    // THE GUARD. seed runs on first mount. If it opened, every page load during
    // a game would pop the panel for a score that happened before the operator
    // even navigated here.
    s.seed(9);
    assert.equal(s.get().open, false, "seeding on mount opened the panel");
    assert.equal(s.get().seenRev, 9);

    // And it has actually taken effect: the rev it seeded is now spent.
    s.scored(9, 0);
    assert.equal(s.get().open, false, "a seeded rev still auto-opened");
  });

  test("focusing a card in the stack opens it and cancels the hold", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const s = createScoreActivity();
      s.scored(1, 0);
      s.focus(2);
      assert.deepEqual(
        { open: s.get().open, focus: s.get().focus },
        { open: true, focus: 2 },
      );
      mock.timers.tick(SCORE_HOLD_MS + 500);
      assert.equal(s.get().open, true, "picking a card left the score's timer running");
    } finally {
      mock.timers.reset();
    }
  });
});

describe("the bar shows a live game, or nothing at all", () => {
  // This used to be four different idle statements — "No teams", "No games",
  // "Scores offline", and ESPN's own "7:05 PM ET". They were each true, and
  // together they were a word that never changed on a strip whose other seven
  // readings all mean something. They are deliberately gone: the bar item is now
  // invisible unless a followed game is IN PLAY.
  //
  // The distinctions themselves are not lost. The Home card and the layout
  // object still keep those four facts apart in their own words, because a wall
  // widget drawing nothing is indistinguishable from a broken one and the
  // operator who placed it is not in the room. Their tests cover that; this one
  // covers the bar, where the honest rendering of "nothing is on" is nothing.
  test("THE GUARD: nothing loaded, or nobody followed, is NOTHING", () => {
    assert.deepEqual(capsuleView(null), { kind: "none" });
    assert.deepEqual(capsuleView(status({ connected: false, games: [] })), { kind: "none" });
  });

  test("a failed poll with nothing to show is nothing here", () => {
    // The failure is not swallowed — it is on the integration's card and in the
    // expanded panel's "Last update failed" line. It is simply not a permanent
    // word in the operator's status strip.
    assert.deepEqual(
      capsuleView(status({ connected: false, games: [], error: "timeout" })),
      { kind: "none" },
    );
  });

  test("followed teams with nothing on today is nothing", () => {
    assert.deepEqual(capsuleView(status({ games: [] })), { kind: "none" });
  });

  test("THE GUARD: a game today that has not started yet is still nothing", () => {
    assert.deepEqual(
      capsuleView(status({ games: [game({ state: "pre", shortDetail: "7:05 PM ET" })] })),
      { kind: "none" },
    );
  });

  test("THE GUARD: a game that has finished is nothing", () => {
    // The operator's case: teams followed, the poll fine, every game Final. A
    // capsule reading "Final" all evening is the noise this removed.
    assert.deepEqual(
      capsuleView(status({ games: [game({ state: "post", shortDetail: "Final" })] })),
      { kind: "none" },
    );
  });

  test("a live game IS the capsule", () => {
    // The other half, and the one that stops "may be empty" becoming "always
    // empty": the capsule still has to appear when a game is actually on.
    const view = capsuleView(status());
    assert.equal(view.kind, "game");
    assert.equal(view.kind === "game" && view.game.eventId, "e1");
  });

  test("a live game beside a finished one is still the capsule", () => {
    const view = capsuleView(
      status({ games: [game({ eventId: "done", state: "post" }), game({ eventId: "on" })] }),
    );
    assert.equal(view.kind === "game" && view.game.eventId, "on");
  });
});

describe("which game the capsule speaks for", () => {
  const a = game({ eventId: "a" });
  const b = game({ eventId: "b" });

  test("the one that just scored, not merely the first live one", () => {
    // THE GUARD. `games` is sorted by start time, so "the first live game" is a
    // perfectly plausible rule -- and it would show the operator a game that has
    // not moved while the panel beneath it opened for one that had.
    assert.equal(liveIndex([a, b], [{ eventId: "b", teamId: "16", from: 5, to: 6 }]), 1);
  });

  test("the earliest live one when nothing has scored", () => {
    assert.equal(liveIndex([a, b], []), 0);
  });

  test("nothing live is -1, whatever else is on today", () => {
    assert.equal(liveIndex([game({ state: "pre" }), game({ state: "post" })], []), -1);
  });

  test("a scoring event on a game that is NOT live does not steal the capsule", () => {
    const finished = game({ eventId: "a", state: "post" });
    assert.equal(liveIndex([finished, b], [{ eventId: "a", teamId: "16", from: 5, to: 6 }]), 1);
  });
});

describe("which side just scored", () => {
  test("resolved against this game's own two ids, never by position", () => {
    assert.equal(scoredSide(game(), [{ eventId: "e1", teamId: "16", from: 5, to: 6 }]), "home");
    assert.equal(scoredSide(game(), [{ eventId: "e1", teamId: "17", from: 1, to: 2 }]), "away");
  });

  test("a team id belonging to neither side highlights neither", () => {
    // THE GUARD. Defaulting to a side is how a possessionText-shaped mix-up
    // sweeps light across the team that did NOT score. The same rule
    // possessionSide follows, for the same reason.
    assert.equal(
      scoredSide(game(), [{ eventId: "e1", teamId: "99", from: 0, to: 3 }]),
      null,
      "an unrelated team id lit up a side of this game",
    );
  });

  test("an event for another game on the board is not this game's", () => {
    assert.equal(scoredSide(game(), [{ eventId: "other", teamId: "16", from: 0, to: 1 }]), null);
  });
});

// ── Which strips replay a one-shot score animation ───────────────────────────
//
// The sweep (`.score-side-scored::after`) and the bump (`.score-value-bump`) are
// CSS animations that run ONCE on mount, so the only thing that can play one
// again is React BUILDING A NEW NODE. That makes the remount key the entire
// mechanism, and what the key is made of is the whole behaviour. See scoreKey in
// score-activity.tsx.
//
// jsdom loads no stylesheet, so nothing here can watch an animation run — the
// same limit the header of this file states for the mask and the stack heights.
// What it CAN see is the one thing that decides whether one runs at all: whether
// the node survived the re-render. Node identity is exact, it needs no layout,
// and these render the SHIPPED components rather than calling scoreKey on its
// own, so a key that goes back to reading `scoreRev` fails them.
//
// Every re-render below bumps `scoreRev` as a real poll does. That is
// load-bearing: with it held still the old global key would not have changed
// either, and the first test would have passed on the bug it exists to catch.

/** Two games, with the away side of the SECOND carrying the score that moves. */
function twoGames(awayTwo: number): ScoresStatusDTO {
  return status({
    games: [
      game({ eventId: "one", away: TEAM("17", 2), home: TEAM("16", 6) }),
      game({ eventId: "two", away: TEAM("17", awayTwo), home: TEAM("16", 1) }),
    ],
  });
}

/** A delivery in which game two's away side has just scored. */
function scoreInGameTwo(to: number): ScoresStatusDTO {
  return {
    ...twoGames(to),
    scoreRev: to,
    lastEvents: [{ eventId: "two", teamId: "17", from: to - 1, to }],
  };
}

/** Each card's strip node, in stack order. */
function strips(container: HTMLElement): Element[] {
  return [...container.querySelectorAll("[data-score-card]")].map((card) => {
    const strip = card.querySelector("[data-score-strip]");
    assert.ok(strip, "a card in the stack rendered no strip");
    return strip;
  });
}

describe("a score replays the animation on the game that scored, and only that one", () => {
  test("THE GUARD: the OTHER game's strip is not rebuilt", () => {
    const { container, rerender } = render(<ScoreActivityHost scores={twoGames(0)} />);
    const before = strips(container);
    assert.equal(before.length, 2, "the stack did not render both games");

    rerender(<ScoreActivityHost scores={scoreInGameTwo(1)} />);
    const after = strips(container);

    // `assert.ok` on a comparison, never `assert.notEqual` on the nodes
    // themselves: a failing assert.equal INSPECTS both values to build its diff,
    // and inspecting two jsdom elements walks a circular graph big enough that
    // the runner killed the whole file at its 30s timeout with no message at
    // all. The bug reintroduction that proved these guards red is exactly when
    // that happens, so a guard that cannot report its own failure is no guard.
    assert.ok(
      after[1] !== before[1],
      "the game that scored kept its node, so its sweep could never play",
    );
    // The bug. A key made from the GLOBAL scoreRev rebuilds every strip in the
    // stack whenever ANY game scores — wasted work today, and the moment a card
    // gains an unconditional entrance animation, four of them replaying it at
    // once for one run in one game.
    assert.ok(
      after[0] === before[0],
      "a score in the other game rebuilt this game's strip, which did not move",
    );
  });

  test("THE GUARD: a SECOND score in the SAME game restarts it", () => {
    const { container, rerender } = render(<ScoreActivityHost scores={scoreInGameTwo(1)} />);
    const first = strips(container)[1];

    rerender(<ScoreActivityHost scores={scoreInGameTwo(2)} />);

    // The property the old global key DID have, and the one a narrower key is
    // most likely to drop: key on the game id alone and the second run in a game
    // reuses the node and animates nothing.
    assert.ok(
      strips(container)[1] !== first,
      "the second score in the same game reused the node, so nothing replayed",
    );
  });

  test("THE GUARD: only the capsule side that scored is rebuilt", () => {
    const { container, rerender } = render(
      <ScoreCapsule game={game({ away: TEAM("17", 2), home: TEAM("16", 6) })} scored={null} />,
    );
    const away = () => container.querySelector(".score-side-away");
    const home = () => container.querySelector(".score-side-home");
    const [wasAway, wasHome] = [away(), home()];

    rerender(
      <ScoreCapsule game={game({ away: TEAM("17", 3), home: TEAM("16", 6) })} scored="away" />,
    );

    assert.ok(away() !== wasAway, "the side that scored kept its node");
    assert.ok(home() === wasHome, "the side that did not score was rebuilt anyway");
  });

  test("THE GUARD: the capsule changing GAME rebuilds the side", () => {
    // The capsule speaks for whichever game is live, and it SWITCHES game the
    // moment another one scores — so the game id has to be in the key. Without
    // it, arriving at a different game whose score happens to match the one
    // leaving reuses the node, and the sweep on the team that just scored never
    // plays.
    const { container, rerender } = render(
      <ScoreCapsule
        game={game({ eventId: "one", away: TEAM("17", 2), home: TEAM("16", 6) })}
        scored={null}
      />,
    );
    const away = () => container.querySelector(".score-side-away");
    const wasAway = away();

    rerender(
      <ScoreCapsule
        game={game({ eventId: "two", away: TEAM("17", 2), home: TEAM("16", 6) })}
        scored="away"
      />,
    );

    assert.ok(away() !== wasAway, "switching to a different game reused the old side's node");
  });
});


// ---- the panel floats -------------------------------------------------------

/**
 * The stylesheet with its comments removed.
 *
 * Load-bearing: the reasoning above each rule below quotes the very declarations
 * this reads, so matching raw text would find the prose and be satisfied by it.
 * CSS comments do not nest and this sheet has no `content:` string carrying those
 * characters, so the strip is exact rather than hopeful.
 */
function stylesheet(): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The body of one rule, by selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = stylesheet().match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `the rule "${selector}" is gone`);
  return m[1];
}

describe("the panel floats over the page rather than pushing it down", () => {
  test("the host hangs off an anchor, which is the whole fix", () => {
    // Structural, and driven through the real component: delete the wrapper in
    // score-activity.tsx and the host is back in the shell's flex column, where
    // its height comes out of the page and opening it on Screens slides every
    // card down. That is the report this change came from.
    const { container } = render(<ScoreActivityHost scores={twoGames(0)} />);
    assert.ok(
      container.querySelector(".score-anchor > .score-host"),
      "the score host is not inside its anchor, so the panel is back in the page's flow",
    );
    // And exactly one anchor: two would be two overlays at the same offset.
    assert.equal(container.querySelectorAll(".score-anchor").length, 1);
  });

  test("the anchor takes no room and the host is out of flow", () => {
    // The pixels are a browser claim - jsdom lays nothing out, so every
    // offsetHeight here reads 0 whatever the sheet says, and a test written on
    // them would pass with the fix reverted. The declarations are what can be
    // checked; the measured page positions are in the PR.
    const anchor = rule(".score-anchor");
    assert.match(anchor, /position:\s*relative/, "the anchor is not a containing block, so the host escapes to the viewport");
    // The lookbehind is not decoration: `min-height: 0` sits in this same rule and
    // ends with the word this is looking for, so a loose pattern matched it and
    // passed with the anchor given a real height - watched do exactly that.
    assert.match(anchor, /(?<!min-)height:\s*0/, "the anchor occupies space, so the panel still pushes the page down");
    const host = rule(".score-host");
    assert.match(host, /position:\s*absolute/, "the host is back in the page's flow");
    // The mechanism the panel's whole animation is built on, and which moving it
    // out of flow was required not to disturb.
    assert.match(host, /grid-template-rows:\s*0fr/, "the height animation's collapsed state is gone");
  });

  test("only the painted panel takes a press, and only while it is open", () => {
    // An overlay that eats clicks is a worse bug than the one being fixed, and it
    // has two halves. SIDEWAYS: the clip is full width while the panel is capped
    // at 640px, so the air beside it would swallow presses meant for the page.
    // IN TIME: a close fades the shell out in 260ms and finishes collapsing at
    // 680ms, and `opacity: 0` still hit-tests - so without the closed-state rule
    // there is a transparent 640px box over the page for the 420ms in between.
    assert.match(rule(".score-host"), /pointer-events:\s*none/, "the empty air beside the panel eats presses meant for the page");
    assert.match(rule(".score-shell"), /pointer-events:\s*auto/, "the panel itself cannot be pressed");
    assert.match(
      rule(".score-host:not(.is-open) .score-shell"),
      /pointer-events:\s*none/,
      "a dismissed panel keeps eating presses while it fades - the 420ms hole between the fade and the collapse",
    );
  });
});

// ---------------------------------------------------------------------------

/**
 * A height jsdom will hand back.
 *
 * jsdom lays nothing out, so `offsetHeight` is 0 on every element whatever the
 * sheet says. Redefining it as a plain value is what makes the arithmetic below
 * observable at all — the same trick page-scroll-reset.test.tsx uses for
 * `scrollTop`, and for the same reason: a version of this test written against
 * the real property passes on the bug, because 24 + 40 + 8 and 24 + 0 + 8 are
 * both 0 when every term is 0.
 *
 * THESE NUMBERS ARE NOT A CLAIM ABOUT PIXELS. What is being checked is which
 * element the focused card's extra height is read from, and that is a fact about
 * the code, not about a browser's layout.
 */
function stubHeight(el: HTMLElement, px: number): HTMLElement {
  Object.defineProperty(el, "offsetHeight", { get: () => px, configurable: true });
  return el;
}

/**
 * A card shaped the way ScoreCard renders one.
 *
 * The nesting is load-bearing rather than decorative. `.score-card-body` is the
 * GRID ITEM that animates 0fr -> 1fr, and it is stubbed at 0: mid-transition it
 * reports the height it is leaving, which is what made reading it the bug. The
 * `[data-score-body]` inside it is `.score-more`, which sits under the clip and
 * always reports its natural height — the reason THAT is what layoutStack reads.
 */
function card(stripPx: number, bodyPx: number): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-score-card", "");
  const strip = document.createElement("div");
  strip.setAttribute("data-score-strip", "");
  const gridItem = document.createElement("div");
  gridItem.className = "score-card-body";
  const clip = document.createElement("div");
  clip.className = "score-card-body-in";
  const body = document.createElement("div");
  body.className = "score-more";
  body.setAttribute("data-score-body", "");
  clip.append(stubHeight(body, bodyPx));
  gridItem.append(clip);
  el.append(stubHeight(strip, stripPx), stubHeight(gridItem, 0));
  document.body.append(el);
  return el;
}

/** The number out of `translateY(<n>px)`. */
function topOf(el: HTMLElement): number {
  const m = /translateY\((-?[\d.]+)px\)/.exec(el.style.transform);
  assert.ok(m, `card was never placed: transform is ${JSON.stringify(el.style.transform)}`);
  return Number(m[1]);
}

describe("placing the stack", () => {
  const GAP = 8;

  test("THE GUARD: the focused card's extra height comes from its BODY, not the grid item", () => {
    // The reported bug. Reading the grid item returns the height it is LEAVING —
    // 0 at the instant focus changes — so every card below the focused one was
    // placed as though the panel had not opened, and the open panel painted over
    // a card the operator then could not click.
    const cards = [card(24, 40), card(24, 40), card(24, 40)];
    const height = layoutStack(cards, 0, GAP, true);

    assert.equal(topOf(cards[0]), 0);
    // 24 strip + 40 body + 8 gap. Off the grid item this is 24 + 0 + 8 = 32.
    assert.equal(topOf(cards[1]), 24 + 40 + GAP);
    assert.equal(topOf(cards[2]), 24 + 40 + GAP + 24 + GAP);
    // The height the container animates to: the last card's bottom, with no
    // trailing gap.
    assert.equal(height, 24 + 40 + GAP + 24 + GAP + 24);
  });

  test("only the FOCUSED card is given its body's height", () => {
    const cards = [card(24, 40), card(24, 40)];
    layoutStack(cards, 1, GAP, true);
    assert.equal(topOf(cards[0]), 0);
    // Card 0 is not focused, so it contributes its strip and nothing else.
    assert.equal(topOf(cards[1]), 24 + GAP);
  });

  test("strips are normalised to the tallest, so leagues do not sit at different heights", () => {
    // A four-row baseball centre and a two-row hockey centre in one stack.
    const cards = [card(24, 0), card(36, 0)];
    const height = layoutStack(cards, -1, GAP, true);
    assert.equal(cards[0].querySelector<HTMLElement>("[data-score-strip]")?.style.height, "36px");
    assert.equal(cards[1].querySelector<HTMLElement>("[data-score-strip]")?.style.height, "36px");
    assert.equal(topOf(cards[1]), 36 + GAP);
    assert.equal(height, 36 + GAP + 36);
  });

  test("the focused card is raised above the ones it grew into", () => {
    const cards = [card(24, 40), card(24, 40)];
    layoutStack(cards, 1, GAP, true);
    assert.equal(cards[0].style.zIndex, "1");
    assert.equal(cards[1].style.zIndex, "5");
  });

  test("an empty stack has no height and nothing to place", () => {
    assert.equal(layoutStack([], 0, GAP, true), 0);
  });
});

/**
 * The panel's open state, set on the ONE store the host reads.
 *
 * ScoreActivityHost renders from the module singleton, not from a store handed
 * in, and several tests above leave it open — a rerender carrying a new scoreRev
 * calls scored(), which opens the panel and starts a 6.5s hold. So anything that
 * depends on open-versus-shut says which it wants rather than inheriting
 * whatever ran before it.
 */
function openPanel(): void {
  scoreActivity.close();
  scoreActivity.toggle();
}
function shutPanel(): void {
  scoreActivity.close();
}

describe("a card names its game once, not twice", () => {
  // ScoreCard sets an aria-label on its role="button" wrapper and then renders a
  // ScoreStrip, which labels itself by default. A screen reader in browse mode
  // announces a labelled element and then the labelled element inside it, so the
  // whole reading — both teams, both scores, the inning — arrives twice for one
  // card. `labelled={false}` on the inner strip is what stops that.
  //
  // Counted, not merely checked for presence: the pre-fix DOM has the label
  // twice, so an assertion that one exists passes on the bug.
  test("THE GUARD: the reading is not announced twice", () => {
    // OPEN, explicitly: a shut panel's cards carry no label at all now (they are
    // aria-hidden — see the tab-order guard below), so this would assert nothing
    // about the double reading if it ran against a collapsed stack.
    openPanel();
    const { container } = render(<ScoreActivityHost scores={twoGames(0)} />);
    const cards = [...container.querySelectorAll("[data-score-card]")];
    assert.ok(cards.length > 0, "no cards rendered, so this asserts nothing");

    for (const card of cards) {
      // The card's own label plus any label on a descendant.
      const labelled = [card, ...card.querySelectorAll("[aria-label]")]
        .filter((el) => (el.getAttribute("aria-label") ?? "").includes("Chicago Cubs"));
      assert.equal(
        labelled.length,
        1,
        `the game is named ${labelled.length} times inside one card — a browse-mode reader says it all again`,
      );
    }
  });

  test("and the capsule still names the game, with its own suffix", () => {
    // NOT preview: a preview chip renders an inert <span> with no label at all
    // (it is the configurator's dead sample), so asserting on it asserts nothing.
    const { container } = render(<ScoreCapsule game={game()} scored={null} />);
    const el = container.querySelector("[aria-label]");
    const label = el?.getAttribute("aria-label") ?? "";
    assert.match(label, /Chicago Cubs 6/, "the capsule stopped naming the game");
    assert.match(label, /Cincinnati Reds 2/);
  });
});

describe("the quiet ink on a score surface is readable", () => {
  // THE BUG. --score-subtle was rgba(255,255,255,.38) and painted #6f6f6f on
  // --score-surface: 3.60:1, under WCAG AA's 4.5:1 floor for text of any size,
  // and all four of its uses were 9.5px or smaller. --score-muted, which is
  // what those four were meant to read at, is 7.43:1.
  //
  // WHAT JSDOM CANNOT SAY: anything about type size or the painted result. No
  // stylesheet is applied and nothing is laid out, so getComputedStyle here
  // returns Tailwind's defaults and a "9.5px" claim would assert nothing. The
  // DECLARATIONS are what can be read, and the arithmetic over them is the app's
  // own — so this measures exactly what a browser will paint, without one.
  //
  // Enumerated FROM THE SHEET rather than from a list written here: a token
  // added tomorrow and painted as text is measured by this the day it lands.

  /** A translucent ink as it is actually painted on an opaque ground. */
  function painted(ink: string, ground: string): string {
    const f = parseColor(ink);
    const b = parseColor(ground);
    assert.ok(f && b, `unparseable colour: ${ink} on ${ground}`);
    return formatColor({
      r: f.r * f.a + b.r * (1 - f.a),
      g: f.g * f.a + b.g * (1 - f.a),
      b: f.b * f.a + b.b * (1 - f.a),
      a: 1,
    });
  }

  /** Every `--score-*: <colour>` the sheet declares. */
  function scoreTokens(): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of stylesheet().matchAll(
      /--score-([a-z0-9-]+):\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))\s*;/gi,
    )) {
      out.set(m[1], m[2].trim());
    }
    return out;
  }

  // Ink that does NOT sit on --score-surface, and is therefore not this file's
  // to measure. Both are computed per team colour in score-ink.ts and held to
  // 4.5:1 by score-ink.test.ts against the ground they actually land on.
  const NOT_ON_THE_SURFACE = ["disc-ink", "ink"];

  test("THE GUARD: every score token painted as text clears 4.5:1 on the surface", () => {
    const tokens = scoreTokens();
    const surface = tokens.get("surface");
    assert.ok(surface, "--score-surface is gone, so there is no ground to measure against");

    const used = [
      ...new Set(
        [...stylesheet().matchAll(/color:\s*var\(--score-([a-z0-9-]+)/gi)].map((m) => m[1]),
      ),
    ].sort();

    // MEASURED FIRST, so the failure reads as the ratio it is rather than as a
    // list that changed shape.
    const onSurface = used.filter((n) => !NOT_ON_THE_SURFACE.includes(n));
    for (const name of onSurface) {
      const value = tokens.get(name);
      assert.ok(value, `--score-${name} is used as a colour but never declared`);
      const ratio = contrastRatio(painted(value, surface), surface);
      assert.ok(
        ratio >= 4.5,
        `--score-${name} paints ${painted(value, surface)} on ${surface} at ${ratio.toFixed(2)}:1 — under the 4.5:1 floor`,
      );
    }

    // EXACT, both halves, and only after the measuring. A floor would let a new
    // quiet-ink token be painted as text and never measured; naming the excluded
    // pair here rather than skipping anything the parser cannot resolve means a
    // THIRD unresolvable token fails loudly instead of vanishing from the loop.
    assert.deepEqual(
      used.filter((n) => NOT_ON_THE_SURFACE.includes(n)).sort(),
      [...NOT_ON_THE_SURFACE].sort(),
      "the ink that sits on a team colour changed — score-ink.test.ts owns those",
    );
    assert.deepEqual(
      onSurface,
      ["fg", "mark", "muted"],
      "a different set of tokens is painted as text on the score surface than this guard measures",
    );
  });

  test("and the quiet tier is one token, at the ratio it was meant to have", () => {
    // The specific numbers, so the swap cannot be undone by re-tuning the alpha
    // back down while leaving one token standing.
    const tokens = scoreTokens();
    const surface = tokens.get("surface") ?? "";
    const muted = tokens.get("muted") ?? "";
    assert.equal(surface, "#161616");
    assert.equal(painted(muted, surface), "#a6a6a6");
    assert.equal(contrastRatio(painted(muted, surface), surface).toFixed(2), "7.43");
    assert.equal(
      tokens.has("subtle"),
      false,
      "--score-subtle is back, and nothing on this surface can use it legibly",
    );
  });
});

describe("a shut panel is not a row of invisible tab stops", () => {
  // THE BUG. The cards stay mounted while the panel is shut — the open
  // animation scales a stack whose heights are already measured — and they kept
  // `role="button" tabIndex={0}` the whole time. The panel rides the context bar
  // on EVERY operator page, so a church following four games had four tab stops
  // that landed on nothing, and Enter on one sprang the panel open from a
  // control the operator could not see.
  //
  // WHAT JSDOM CANNOT SAY, and is therefore not asserted here: that the shut
  // stack is invisible. Nothing is laid out, no stylesheet is applied, and every
  // box measures 0 — so a pixel claim would pass with the rule that hides the
  // stack deleted. The CSS side (`.score-host:not(.is-open) .score-shell`) is
  // verified in a browser and the walk-through is in the PR. What IS checkable
  // is the two lists a control nobody can see must be off: the tab order and
  // the accessibility tree.
  test("THE GUARD: a collapsed card is not a control, in either list", () => {
    shutPanel();
    const { container } = render(<ScoreActivityHost scores={twoGames(0)} />);
    const cards = [...container.querySelectorAll<HTMLElement>("[data-score-card]")];
    // EXACT, not a floor: two games in, two cards out. A zero here would make
    // every assertion below vacuously true.
    assert.equal(cards.length, 2, "the shut stack did not render its cards");

    for (const card of cards) {
      assert.equal(
        card.hasAttribute("tabindex"),
        false,
        "a card in a SHUT panel still carries a tabindex — an invisible tab stop on every operator page",
      );
      // The computed value too, and it is not the same check: a bare <div>
      // reports -1, which is what keeps aria-hidden legal here. An explicit
      // tabIndex={-1} would satisfy the attribute check above while leaving the
      // node programmatically focusable inside a hidden subtree.
      assert.equal(card.tabIndex, -1, "a collapsed card is still focusable");
      assert.equal(
        card.getAttribute("aria-hidden"),
        "true",
        "a card in a SHUT panel is still in the accessibility tree",
      );
      assert.equal(
        card.getAttribute("role"),
        null,
        "a collapsed card still announces itself as a button",
      );
      assert.equal(card.getAttribute("aria-label"), null);
    }
  });

  test("and it is a real control again the moment the panel opens", () => {
    // The other half of the rule. Taking the tab stop away must not have taken
    // the card away: a fix that left the cards inert while open would satisfy
    // the guard above and remove the panel's only keyboard path.
    openPanel();
    const { container } = render(<ScoreActivityHost scores={twoGames(0)} />);
    const cards = [...container.querySelectorAll<HTMLElement>("[data-score-card]")];
    assert.equal(cards.length, 2);
    for (const card of cards) {
      assert.equal(card.getAttribute("role"), "button", "an open card is not a control");
      assert.equal(card.getAttribute("tabindex"), "0", "an open card is not tab-reachable");
      assert.equal(card.getAttribute("aria-hidden"), null, "an open card is hidden from readers");
      assert.ok(card.getAttribute("aria-label"), "an open card lost its name");
    }
    // UNMOUNT FIRST, then put the store back. Closing it while the host is still
    // mounted publishes to a live subscriber, and React schedules that re-render
    // for after this test body returns — by which time the file's `after()` has
    // taken `window` away and the render throws inside prefersReducedMotion().
    // cleanup() is idempotent, so the file's own afterEach still works.
    cleanup();
    shutPanel();
  });
});
