// The React half of server-clock.ts. The maths is guarded in
// server-clock.test.ts against an injected pair of clocks; what is left here is
// the one rule the hooks add — a component must NOT feed the page's clock from
// the `serverNow` it holds at mount.
//
// The SSE hello burst that seeds every subscriber is a replayed snapshot and can
// be five minutes old outside a service. Measuring it set the skew to minus
// several minutes and every consumer — the context bar clock, PVP's progress bar,
// the countdown in the rundown — rendered several minutes fast until a real frame
// landed. The best-of-window filter in ServerClock rejects a stale sample once a
// fresher one sits beside it, but at mount it can be the ONLY sample and would be
// adopted as the best of one. So the guard stays, and this holds it.
//
// NOT UNIT-TESTED HERE, deliberately: that a clock on screen reads the corrected
// time. jsdom loads no stylesheet, lays nothing out and reports every
// `offsetHeight` as 0, so the readouts these feed (Readout sizes itself from its
// box) render at a size no assertion here could tell from any other. That was
// driven in a real browser instead — see the PR body.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, act } = await import("@testing-library/react");
const { serverClock, useServerClockSample, useServerNow } = await import("./server-clock.js");

after(() => {
  cleanup();
  teardown();
});

beforeEach(() => {
  serverClock.reset();
});

function Probe({ serverNow }: { serverNow: string | null | undefined }) {
  useServerClockSample(serverNow);
  const now = useServerNow(1000);
  return <div data-testid="out">{now}</div>;
}

/** What the probe currently reads, minus this host's own clock. */
function shownSkewMs(view: { getByTestId: (id: string) => HTMLElement }): number {
  return Number(view.getByTestId("out").textContent) - Date.now();
}

describe("useServerClockSample", () => {
  test("does not adopt the serverNow it was mounted with, however stale", (t) => {
    const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const view = render(<Probe serverNow={stale} />);
    t.after(() => cleanup());
    assert.equal(
      serverClock.synced(),
      false,
      "a replayed mount-time frame was fed to the clock; it can be five minutes old",
    );
    assert.ok(
      Math.abs(shownSkewMs(view)) < 1000,
      `the surface should still be reading its own clock, it is ${shownSkewMs(view)}ms out`,
    );
  });

  test("adopts a serverNow that arrives after mount", (t) => {
    const view = render(<Probe serverNow={null} />);
    t.after(() => cleanup());
    const fresh = new Date(Date.now() + 90_000).toISOString();
    act(() => {
      view.rerender(<Probe serverNow={fresh} />);
    });
    assert.equal(serverClock.synced(), true, "a frame that arrived after mount is a real reading and must be taken");
    assert.ok(
      Math.abs(serverClock.now() - Date.parse(fresh)) < 1000,
      `the clock should now read the server's time; it is ${serverClock.now() - Date.parse(fresh)}ms off it`,
    );
  });

  test("a mount-time frame is still refused once a later render repeats it", (t) => {
    // React remounts effects under StrictMode, which is how the app mounts. A
    // "have I run before" flag flips on that second pass and would then take the
    // mount value; comparing the VALUE does not.
    const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const view = render(<Probe serverNow={stale} />);
    t.after(() => cleanup());
    act(() => {
      view.rerender(<Probe serverNow={null} />);
    });
    act(() => {
      view.rerender(<Probe serverNow={stale} />);
    });
    assert.equal(serverClock.synced(), false, "the mount-time frame was taken on a later pass");
  });

  test("an unparseable serverNow is refused rather than poisoning the clock", (t) => {
    const view = render(<Probe serverNow={null} />);
    t.after(() => cleanup());
    act(() => {
      view.rerender(<Probe serverNow="not a date" />);
    });
    assert.equal(serverClock.synced(), false);
  });
});

describe("useServerNow", () => {
  test("reads the host clock until the page's clock has a reading", (t) => {
    const view = render(<Probe serverNow={null} />);
    t.after(() => cleanup());
    assert.ok(
      Math.abs(shownSkewMs(view)) < 1000,
      `with nothing to correct against the only honest answer is the host clock; off by ${shownSkewMs(view)}ms`,
    );
  });

  test("every surface reads the SAME clock, not one estimate each", (t) => {
    const a = render(<Probe serverNow={null} />);
    t.after(() => cleanup());
    const fresh = new Date(Date.now() + 120_000).toISOString();
    act(() => {
      a.rerender(<Probe serverNow={fresh} />);
    });
    // A second surface that has fed the clock nothing at all still reads the
    // correction the first one measured.
    const b = render(<Probe serverNow={null} />);
    const shown = Number(b.container.querySelector("[data-testid='out']")?.textContent);
    assert.ok(
      Math.abs(shown - Date.parse(fresh)) < 1000,
      `a second surface fell back to its own clock instead of the page's, by ${shown - Date.parse(fresh)}ms`,
    );
  });
});
