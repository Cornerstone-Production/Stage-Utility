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
//   2. THE STACK'S MEASURED HEIGHTS. Every offsetHeight in jsdom is 0, so
//      layoutStack returns 0 for any input and every card lands at
//      translateY(0). A test would assert the cards do not overlap and pass
//      while they all sat on top of each other, and it would pass equally with
//      the measurement taken from the grid item being animated — the mistake
//      that placed every card below the focused one too high and made the card
//      underneath unclickable.
//
// Both are verified in a real browser instead, against the checklist in Task 5
// step 7 of docs/superpowers/plans/2026-08-29-live-scores.md. What IS guarded
// here is everything that is pure logic and therefore cannot lie to jsdom: the
// hold timer, the rev guard, the seed, and which of four things the bar says.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, mock, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { createScoreActivity, SCORE_HOLD_MS } = await import("./score-activity-store.js");
const { ScoreActivityHost, ScoreCapsule, capsuleView, liveIndex, scoredSide } = await import(
  "./score-activity.js"
);

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
