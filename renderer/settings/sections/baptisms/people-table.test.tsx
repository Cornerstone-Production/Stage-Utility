// people-table.test.tsx — the People card's empty state, its rendered splits,
// and the guard that a not-yet-baptized person shows a dash rather than
// "0:00". NOT tested here: whether the split bar's width READS at a glance —
// jsdom lays nothing out. See people-table.tsx's own header.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../../../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { PeopleCard } = await import("./people-table.js");

afterEach(cleanup);
after(() => unmountAndTeardown(cleanup, teardown));

function state(people: BaptismPerson[]): BaptismState {
  return {
    serviceKey: null,
    mode: "grouped",
    phase: people.length ? "baptism" : "idle",
    personNumber: people.length + 1,
    baptismIndex: 0,
    segmentStartedAt: null,
    autoStartedFrom: null,
    sessionStartedAt: people.length ? "2026-09-20T15:00:00.000Z" : null,
    finishedAt: null,
    people,
    pendingTestimonyMs: null,
    serviceTitle: null,
    serviceTypeId: null,
    planId: null,
  };
}

describe("PeopleCard — empty state", () => {
  test("nobody timed yet says so and offers no table", () => {
    const view = render(React.createElement(PeopleCard, { state: state([]) }));
    assert.ok(view.container.textContent?.includes("Nobody timed yet"));
    // A boolean, never the node itself: a raw jsdom element as the "actual"
    // value makes a failure's util.inspect walk the live DOM tree and hang
    // for ~22s instead of reporting the mismatch.
    assert.equal(view.container.querySelector("table") != null, false);
    assert.ok(view.container.textContent?.includes("none yet"));
  });
});

describe("PeopleCard — rows", () => {
  test("renders one row per person with testimony, baptism and total formatted", () => {
    const view = render(
      React.createElement(PeopleCard, {
        state: state([
          { testimonyMs: 108_000, baptizeMs: 42_000 },
          { testimonyMs: 96_000, baptizeMs: 38_000 },
        ]),
      }),
    );
    const rows = view.container.querySelectorAll("tbody tr");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].textContent?.includes("Person 1"), true);
    assert.equal(rows[0].textContent?.includes("1:48"), true, "testimony 108s formatted");
    assert.equal(rows[0].textContent?.includes("0:42"), true, "baptism 42s formatted");
    assert.equal(rows[0].textContent?.includes("2:30"), true, "total 150s formatted");
    assert.ok(view.container.textContent?.includes("2 timed"));
  });

  test("the split bar's two segments are proportioned to testimony and baptism time", () => {
    const view = render(
      React.createElement(PeopleCard, {
        state: state([{ testimonyMs: 75_000, baptizeMs: 25_000 }]),
      }),
    );
    const testimonySeg = view.container.querySelector('[data-split="testimony"]') as HTMLElement;
    const baptismSeg = view.container.querySelector('[data-split="baptism"]') as HTMLElement;
    assert.equal(testimonySeg.style.width, "75%");
    assert.equal(baptismSeg.style.width, "25%");
  });
});

describe("PeopleCard — a not-yet-baptized person shows a dash, never 0:00", () => {
  test("baptizeMs === 0 renders a dash under Baptism", () => {
    const view = render(
      React.createElement(PeopleCard, {
        state: state([{ testimonyMs: 90_000, baptizeMs: 0 }]),
      }),
    );
    const row = view.container.querySelector("tbody tr")!;
    assert.equal(row.textContent?.includes("0:00"), false, "a dash, not a claimed zero-length baptism");
    assert.equal(row.textContent?.includes("—"), true, "expected the dash");
  });

  test("a real baptism of a few seconds still prints its own clock, not a dash", () => {
    const view = render(
      React.createElement(PeopleCard, {
        state: state([{ testimonyMs: 90_000, baptizeMs: 3_000 }]),
      }),
    );
    const row = view.container.querySelector("tbody tr")!;
    assert.equal(row.textContent?.includes("0:03"), true, "a genuine 3-second baptism must not be swallowed by the dash rule");
  });
});
