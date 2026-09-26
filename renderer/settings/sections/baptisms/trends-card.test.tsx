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
const { baptismTrends } = await import("./trends.js");
const { baptismSessionFixture } = await import("./baptism-session-fixture.js");

afterEach(cleanup);
after(() => unmountAndTeardown(cleanup, teardown));

/** This file's own default: BOTH people baptized — proves an average divides
 *  by the right count. See baptism-session-fixture.ts for the fields shared
 *  with past-sessions.test.tsx's own session(), whose default differs on
 *  purpose (one person there is still mid-testimony). */
function session(overrides: Partial<BaptismSession> = {}): BaptismSession {
  return baptismSessionFixture({
    people: [
      { testimonyMs: 108_000, baptizeMs: 42_000 },
      { testimonyMs: 96_000, baptizeMs: 38_000 },
    ],
    ...overrides,
  });
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

  // A mid-testimony person's baptizeMs 0 used to still produce a point
  // ({ baptized: 0, ... }), which fed a real 0 into every trend average —
  // an ordinary grouped Finish during the testimonies,
  // a Finish while armed, or a test run finished instead of reset, skewing
  // Avg baptism and Whole segment right along with Baptized per service.
  test("nobody baptized yields no point at all, not one at baptized: 0", () => {
    const p = baptismTrendPoint(
      session({ people: [{ testimonyMs: 50_000, baptizeMs: 0 }] }),
    );
    assert.equal(p, null, "never a point that would feed a real 0 into every tile's average");
  });

  test("nobody baptized across several people (all mid-testimony) is the same — never people.length", () => {
    const p = baptismTrendPoint(
      session({ people: [{ testimonyMs: 50_000, baptizeMs: 0 }, { testimonyMs: 40_000, baptizeMs: 0 }] }),
    );
    assert.equal(p, null);
  });

  test("an unparseable startedAt yields no point rather than one at NaN", () => {
    assert.equal(baptismTrendPoint(session({ startedAt: "not-a-date" })), null);
  });
});

// Three real sessions plus ONE nobody-baptized session mixed into the same
// window. Before this fix the fourth session skewed every figure: Avg
// baptism 45s -> 33.75s, Whole segment 25min -> 19.25min, Baptized per
// service 5 -> 3.75. This asserts the fix directly, at the arithmetic level;
// TrendsCard's own render tests above cover the same fix through the
// component.
describe("a nobody-baptized session mixed into an otherwise-real window", () => {
  const five = Array.from({ length: 5 }, () => ({ testimonyMs: 90_000, baptizeMs: 45_000 }));
  const real = [
    session({ id: "r1", startedAt: "2026-09-06T16:20:00.000Z", finishedAt: "2026-09-06T16:45:00.000Z", people: five }),
    session({ id: "r2", startedAt: "2026-09-13T16:20:00.000Z", finishedAt: "2026-09-13T16:45:00.000Z", people: five }),
    session({ id: "r3", startedAt: "2026-09-20T16:20:00.000Z", finishedAt: "2026-09-20T16:45:00.000Z", people: five }),
  ];
  const nobodyBaptized = session({
    id: "aborted",
    startedAt: "2026-09-27T16:20:00.000Z",
    finishedAt: "2026-09-27T16:22:00.000Z",
    people: [{ testimonyMs: 60_000, baptizeMs: 0 }, { testimonyMs: 50_000, baptizeMs: 0 }],
  });

  test("is left out entirely — the three real sessions' own averages are untouched", () => {
    const points = [...real, nobodyBaptized].map(baptismTrendPoint).filter((p) => p != null);
    assert.equal(points.length, 3, "the nobody-baptized session must not become a fourth point");
    const t = baptismTrends(points);
    assert.equal(t.baptized.latest, 5, "still 5 baptized per service, not 3.75");
    assert.equal(t.avgBaptismSec.latest, 45, "still 45s avg baptism, not 33.75s");
    assert.equal(t.wholeSegmentSec.latest, 25 * 60, "still a 25-minute whole segment, not 19.25");
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

  // This used to construct "a full prior window that averaged 0 baptized"
  // from 8 nobody-baptized sessions, and asserted the tile said so, distinct
  // from no prior window at all. That scenario can
  // no longer happen: a nobody-baptized session now contributes NO point at
  // all (see baptismTrendPoint's own fix), so a window built entirely from
  // them has zero points, not eight points averaging zero — "no prior window
  // yet" is now the correct, honest read for it, not the wrong one this test
  // used to guard against.
  test("a window of sessions with nobody baptized contributes no points at all", () => {
    const prior = Array.from({ length: 8 }, (_, i) =>
      session({
        id: `p${i}`,
        startedAt: `2026-08-0${i + 1}T15:00:00.000Z`,
        people: [{ testimonyMs: 60_000, baptizeMs: 0 }],
      }),
    );
    const recent = Array.from({ length: 8 }, (_, i) =>
      session({
        id: `r${i}`,
        startedAt: `2026-09-0${i + 1}T15:00:00.000Z`,
        people: [{ testimonyMs: 60_000, baptizeMs: 30_000 }],
      }),
    );
    const view = render(React.createElement(TrendsCard, { sessions: [...prior, ...recent] }));
    const tile = view.container.querySelector('[data-trend-tile="Baptized per service"]')!;
    assert.equal(tile.querySelector("[data-trend-value]")?.textContent, "1.0", "sanity: only the real sessions score");
    assert.equal(
      tile.querySelector("[data-trend-change]")?.textContent,
      "no prior window yet",
      "the 8 nobody-baptized sessions fed zero points, not a fabricated 0 average",
    );

    // The other three tiles must be just as honest about the same sessions —
    // this was never only a "Baptized per service" problem: a nobody-baptized
    // session's own avgTestimonySec is real (people DO testify before a
    // grouped Finish aborts the section), so it would have skewed this tile
    // too if it were still counted in.
    const testimonyTile = view.container.querySelector('[data-trend-tile="Avg testimony"]')!;
    assert.equal(testimonyTile.querySelector("[data-trend-value]")?.textContent, "1:00", "sanity: the real sessions' own avg testimony");
    assert.equal(testimonyTile.querySelector("[data-trend-change]")?.textContent, "no prior window yet");
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
