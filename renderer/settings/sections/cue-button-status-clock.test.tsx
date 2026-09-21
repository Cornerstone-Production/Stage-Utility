// `CueButtonStatus` dates a server stamp, and it reads the clock at the one
// moment the clock is guaranteed not to be set.
//
// `lastSeenAt` is written by companion-reconcile on the SERVER, so "3 hours ago"
// is measured against the server's clock or it is measured against the operator's
// drift. Reading `serverClock.now()` in a lazy state initializer looks like the
// fix and is not: on a cold page load the clock has not been set, `now()` returns
// the host's clock by design, and a value fixed there keeps the drift for the
// life of the page. The clock announces its first reading; this row has to listen
// for it.
//
// A ticking hook would also work and is the wrong instrument: there is one of
// these per rule, the wording changes hourly, and a list of them re-rendering
// once a second is a cost with no reading behind it.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

/** The server's clock. The button was last seen one hour before it. */
const SERVER_NOW = Date.parse("2026-08-14T14:00:00.000Z");
const LAST_SEEN = new Date(SERVER_NOW - 3_600_000).toISOString();
/** This console's clock: four hours fast. Unattended, no NTP, same as a panel. */
const DRIFTED = SERVER_NOW + 4 * 3_600_000;

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { CueButtonStatus } = await import("./companion-cues.js");
const { serverClock } = await import("../../lib/server-clock.js");

const realNow = Date.now;
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  cleanup();
  serverClock.reset();
  Date.now = () => DRIFTED;
});
afterEach(async () => {
  Date.now = realNow;
  cleanup();
  await settle();
});
after(async () => {
  Date.now = realNow;
  await settle();
  teardown();
});

/** A rule whose button moved, which is the one state that dates itself. */
const MOVED = {
  status: "moved",
  page: 3,
  row: 1,
  col: 2,
  pageId: "page-3",
  label: "Stinger",
  actionIds: "a1",
  lastSeenAt: LAST_SEEN,
  movedFrom: "",
};

describe("CueButtonStatus dates a server stamp on the server's clock", () => {
  test("a cold page load re-reads once the clock is set", async () => {
    // Mounted BEFORE any frame has arrived, which is every page load: the row is
    // drawn from the host's clock because there is nothing else, and must correct
    // itself when the first reading lands rather than keeping the drift.
    const view = render(React.createElement(CueButtonStatus, { params: MOVED } as never));
    await act(async () => {
      await settle();
    });
    assert.match(
      view.container.textContent ?? "",
      /5 hours ago/,
      "with no clock set yet the only honest answer is the host's, so this is the state under test",
    );

    await act(async () => {
      serverClock.observe(SERVER_NOW, 20); // the first poll answers
      await settle();
    });
    assert.match(
      view.container.textContent ?? "",
      /1 hour ago/,
      `the row kept this console's four-hour drift for the life of the page: ${view.container.textContent}`,
    );
  });

  test("a row mounted after the clock is set reads it straight away", async () => {
    serverClock.observe(SERVER_NOW, 20);
    const view = render(React.createElement(CueButtonStatus, { params: MOVED } as never));
    await act(async () => {
      await settle();
    });
    assert.match(view.container.textContent ?? "", /1 hour ago/);
  });
});
