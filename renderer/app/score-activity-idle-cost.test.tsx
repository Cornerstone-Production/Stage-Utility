// A panel nobody has opened costs nothing.
//
// `relayout` clears every strip's inline height and then reads `offsetHeight`,
// which is a forced synchronous layout. It ran from a `useLayoutEffect` with no
// dependency list — after EVERY render — and again on the next animation frame.
// ScoreActivityHost lives in the context strip, which re-renders once a second to
// tick its clock, so every operator page in the building was paying two forced
// reflows a second to measure a stack that was shut.
//
// WHAT THIS CAN AND CANNOT SEE. jsdom does no layout: every `offsetHeight` is 0,
// so nothing here is a claim about the panel's geometry — that is verified in a
// real browser, and `layoutStack`'s arithmetic is unit-tested next door. What a
// counting getter CAN see is exactly the thing at issue: whether the measurement
// was taken at all.
//
// The guarded number is EXACTLY ZERO. The second test is the instrument's
// control — open the panel and the reads must appear — because a zero that came
// from a component which never measures anything, or from a getter the render
// never reaches, would look like success.

import { strict as assert } from "node:assert";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { scoreActivity } = await import("./score-activity-store.js");
const { ScoreActivityHost } = await import("./score-activity.js");

/** Every id, name and colour below is invented. This is a public repository. */
const TEAM = (id: string, score: number | null): ScoreTeamDTO => ({
  id,
  abbreviation: id === "a" ? "NOR" : "STH",
  name: id === "a" ? "North" : "South",
  displayName: id === "a" ? "North Rivers" : "South Ridge",
  color: id === "a" ? "#2f6f4f" : "#7a3b2e",
  logo: null,
  record: null,
  score,
});

const STATUS: ScoresStatusDTO = {
  connected: true,
  games: [
    {
      eventId: "game-1",
      league: "mlb",
      sport: "baseball",
      state: "in",
      delayed: false,
      detail: "Second half",
      shortDetail: "2nd",
      clock: "",
      startsAt: "2026-08-14T18:05:00.000Z",
      venue: null,
      away: TEAM("a", 14),
      home: TEAM("b", 10),
      situation: null,
    },
  ],
  scoreRev: 0,
  lastEvents: [],
  fetchedAt: null,
  error: null,
};

/** How many times anything asked the DOM for a laid-out height. */
let measurements = 0;
const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
const original = Object.getOwnPropertyDescriptor(proto, "offsetHeight");

before(() => {
  Object.defineProperty(proto, "offsetHeight", {
    get() {
      measurements++;
      // jsdom lays nothing out, so 0 is the honest answer and the one it already
      // gave. Nothing here asserts a height.
      return 0;
    },
    configurable: true,
  });
});
after(() => {
  if (original) Object.defineProperty(proto, "offsetHeight", original);
  else delete (proto as Record<string, unknown>).offsetHeight;
  scoreActivity.close();
  teardown();
});

beforeEach(() => {
  scoreActivity.close();
  measurements = 0;
});
afterEach(() => {
  cleanup();
  scoreActivity.close();
});

describe("the scores panel measures nothing while it is closed", () => {
  test("THE GUARD: a closed panel takes no measurement, however often the bar re-renders", () => {
    const { rerender } = render(React.createElement(ScoreActivityHost, { scores: STATUS }));
    // The context strip re-renders once a second to tick its clock, and the
    // layout effect has no dependency list, so each of these is one pass the old
    // code paid two forced reflows for.
    for (let i = 0; i < 5; i++) rerender(React.createElement(ScoreActivityHost, { scores: STATUS }));

    assert.equal(
      measurements,
      0,
      `a closed panel measured the DOM ${measurements} times over six renders — that is a forced ` +
        `synchronous layout per render, on every operator page, for a stack nobody can see`,
    );
  });

  test("the control: opening it does measure, so the count above means something", () => {
    render(React.createElement(ScoreActivityHost, { scores: STATUS }));
    assert.equal(measurements, 0);

    // `act`, because opening publishes into the store and the host re-renders
    // off that subscription.
    act(() => scoreActivity.toggle());

    assert.ok(
      measurements > 0,
      "opening the panel took no measurement either — the getter is not on the path this test claims to watch",
    );
  });
});
