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
import { after, describe, mock, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { createScoreActivity, SCORE_HOLD_MS } = await import("./score-activity-store.js");
const { capsuleView, liveIndex, scoredSide } = await import("./score-activity.js");

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
    rev: 0,
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

describe("what the bar says when there is no live game", () => {
  // Four different statements, and each of them is a different fact. Collapsing
  // any two loses the one thing the operator needs to know: whether they have
  // set it up, whether there is anything on today, or whether we simply could
  // not ask.
  test("nothing loaded, or nobody followed, reads as no teams", () => {
    assert.deepEqual(capsuleView(null), { kind: "idle", text: "No teams" });
    assert.deepEqual(capsuleView(status({ connected: false, games: [] })), {
      kind: "idle",
      text: "No teams",
    });
  });

  test("a failed poll with nothing to show says so, rather than 'no games'", () => {
    // THE GUARD. "No games" for a failed request tells the operator a factual
    // lie about their teams' schedule. It has to be distinguishable.
    assert.deepEqual(capsuleView(status({ connected: false, games: [], error: "timeout" })), {
      kind: "idle",
      text: "Scores offline",
    });
  });

  test("followed teams with nothing on today reads as no games", () => {
    assert.deepEqual(capsuleView(status({ games: [] })), { kind: "idle", text: "No games" });
  });

  test("a game today that has not started shows ESPN's own detail", () => {
    const view = capsuleView(status({ games: [game({ state: "pre", shortDetail: "7:05 PM ET" })] }));
    assert.deepEqual(view, { kind: "idle", text: "7:05 PM ET" });
  });

  test("a live game is the capsule", () => {
    const view = capsuleView(status());
    assert.equal(view.kind, "game");
    assert.equal(view.kind === "game" && view.game.eventId, "e1");
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
