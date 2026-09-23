// trends-card.test.tsx — baptismTrendPoint's reduction from a session,
// fmtClockDelta's formatting, and the TrendsCard's three states (loaded,
// empty, load-failed). NOT tested here: tile layout and wrapping — jsdom lays
// nothing out — nor the headline figure's type size, which the approved mockup
// sets at 26px: jsdom loads no stylesheet, so a computed font size is only
// readable in a real browser. See trends-card.tsx's own header.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../../../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { fmtClockDelta, baptismTrendPoint, TrendsCard } = await import("./trends-card.js");

afterEach(cleanup);
after(() => unmountAndTeardown(cleanup, teardown));

function session(overrides: Partial<BaptismSession> = {}): BaptismSession {
  return {
    id: "bap-1",
    startedAt: "2026-09-20T15:00:00.000Z",
    finishedAt: "2026-09-20T15:17:23.000Z",
    people: [
      { testimonyMs: 108_000, baptizeMs: 42_000 },
      { testimonyMs: 96_000, baptizeMs: 38_000 },
    ],
    title: "Sunday Gathering",
    serviceTypeId: null,
    planId: null,
    serviceKey: "weekend:plan-1:1100",
    ...overrides,
  };
}

describe("fmtClockDelta", () => {
  test("exactly zero prints 0s, unsigned", () => {
    assert.equal(fmtClockDelta(0), "0s");
  });
  test("a positive sub-minute change prints +Ns", () => {
    assert.equal(fmtClockDelta(4_000), "+4s");
  });
  test("a negative sub-minute change prints the minus sign, not a hyphen", () => {
    assert.equal(fmtClockDelta(-3_000), "−3s");
  });
  test("a change of a minute or more prints m:ss, not seconds", () => {
    assert.equal(fmtClockDelta(5 * 60_000 + 2_000), "+5:02");
    assert.equal(fmtClockDelta(-(60_000)), "−1:00");
  });
});

describe("baptismTrendPoint", () => {
  test("reduces a session to its baptized count, averages and wall-clock segment", () => {
    const p = baptismTrendPoint(session());
    assert.ok(p);
    assert.equal(p!.baptized, 2, "both people have baptizeMs > 0");
    assert.equal(p!.avgTestimonySec, 102, "(108+96)/2 seconds");
    assert.equal(p!.avgBaptismSec, 40, "(42+38)/2 seconds");
    assert.equal(p!.wholeSegmentSec, 17 * 60 + 23, "finishedAt - startedAt, wall clock");
  });

  test("a mid-testimony person (baptizeMs 0) does not count as baptized", () => {
    const p = baptismTrendPoint(
      session({ people: [{ testimonyMs: 50_000, baptizeMs: 0 }] }),
    );
    assert.equal(p!.baptized, 0, "never people.length — nobody has been baptized yet");
  });

  test("an unparseable startedAt yields no point rather than one at NaN", () => {
    assert.equal(baptismTrendPoint(session({ startedAt: "not-a-date" })), null);
  });
});

describe("TrendsCard", () => {
  test("no sessions: says so, not a blank card", () => {
    const view = render(React.createElement(TrendsCard, { sessions: [] }));
    assert.ok(view.container.textContent?.includes("No baptism sessions recorded yet"));
  });

  test("a load failure reads as a failure, never as an empty list", () => {
    const view = render(React.createElement(TrendsCard, { sessions: [], loadError: true }));
    const alert = view.container.querySelector('[role="alert"]');
    assert.ok(alert, "expected a role=alert failure state");
    assert.ok(alert!.textContent?.includes("could not be loaded"));
    assert.equal(view.container.textContent?.includes("No baptism sessions recorded yet"), false);
  });

  test("fewer than MIN_PRIOR_DAYS sessions shows the headline and 'no prior window yet', never a fabricated change", () => {
    const view = render(React.createElement(TrendsCard, { sessions: [session()] }));
    const tile = view.container.querySelector('[data-trend-tile="Baptized per service"]');
    assert.ok(tile);
    assert.equal(tile!.querySelector("[data-trend-value]")?.textContent, "2.0");
    assert.equal(tile!.querySelector("[data-trend-change]")?.textContent, "no prior window yet");
  });

  test("Baptized per service colours an increase ok and a decrease danger; duration tiles never claim a direction", () => {
    // TrendsCard always uses the default TREND_WINDOW (8), so the "recent"
    // window needs a full 8 sessions to mean anything — 8 prior at 1 person
    // each, then a full 8 recent at 3 each.
    const prior = Array.from({ length: 8 }, (_, i) =>
      session({ id: `p${i}`, startedAt: `2026-08-0${i + 1}T15:00:00.000Z`, people: [{ testimonyMs: 60_000, baptizeMs: 30_000 }] }),
    );
    const recent = Array.from({ length: 8 }, (_, i) =>
      session({
        id: `r${i}`,
        startedAt: `2026-09-0${i + 1}T15:00:00.000Z`,
        people: [
          { testimonyMs: 60_000, baptizeMs: 30_000 },
          { testimonyMs: 60_000, baptizeMs: 30_000 },
          { testimonyMs: 60_000, baptizeMs: 30_000 },
        ],
      }),
    );
    const view = render(React.createElement(TrendsCard, { sessions: [...prior, ...recent] }));
    const baptizedTile = view.container.querySelector('[data-trend-tile="Baptized per service"]')!;
    assert.equal(baptizedTile.querySelector("[data-trend-value]")?.textContent, "3.0");
    const change = baptizedTile.querySelector("[data-trend-change]") as HTMLElement;
    assert.equal(change.textContent, "+200%");
    assert.equal(change.className.includes("text-ok-11"), true, "an increase in baptized count must read as good news");

    const testimonyTile = view.container.querySelector('[data-trend-tile="Avg testimony"]')!;
    const testimonyChange = testimonyTile.querySelector("[data-trend-change]") as HTMLElement;
    assert.equal(testimonyChange.textContent, "0s", "avg testimony did not move between the two windows");
    assert.equal(
      testimonyChange.className.includes("text-ok-11") || testimonyChange.className.includes("text-danger-11"),
      false,
      "a duration tile must never claim a direction is good or bad",
    );
  });
});
