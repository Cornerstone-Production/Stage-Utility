// useServerSkew must NOT measure on mount: the mount-time `serverNow` can be
// the SSE hello burst, a replayed snapshot up to five minutes old outside a
// service. Measuring it there set the skew to minus several minutes instead of
// leaving it 0 until a fresh frame arrived. useResyncOn deliberately runs its
// reset on mount too, so this hook cannot be built on top of it directly — it
// needs its own "last seen" ref seeded with the MOUNT value, not `null`.
//
// The guard: seed the ref with `null` instead of the mount-time `serverNow`
// and test 1 goes red, because the mount value would then look like a change
// from `null` and get measured.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, act } = await import("@testing-library/react");
const { useServerSkew } = await import("./use-server-skew.js");

after(() => {
  cleanup();
  teardown();
});

function Probe({ serverNow }: { serverNow: string | null | undefined }) {
  const skewMs = useServerSkew(serverNow);
  return <div data-testid="out">{skewMs}</div>;
}

describe("useServerSkew", () => {
  test("returns 0 on mount even with a stale serverNow", (t) => {
    const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const view = render(<Probe serverNow={stale} />);
    t.after(() => cleanup());
    assert.equal(
      view.getByTestId("out").textContent,
      "0",
      "measured the mount-time serverNow instead of leaving skew at 0 until a fresh frame lands",
    );
  });

  test("measures the skew once serverNow changes", (t) => {
    const view = render(<Probe serverNow={null} />);
    t.after(() => cleanup());
    const next = new Date(Date.now() - 2000).toISOString();
    const expected = Date.parse(next) - Date.now();
    act(() => {
      view.rerender(<Probe serverNow={next} />);
    });
    const got = Number(view.getByTestId("out").textContent);
    assert.ok(Math.abs(got - expected) <= 50, `expected ~${expected}, got ${got}`);
  });

  test("keeps the value when serverNow is unchanged", (t) => {
    const first = new Date(Date.now() - 1000).toISOString();
    const view = render(<Probe serverNow={first} />);
    t.after(() => cleanup());
    act(() => {
      view.rerender(<Probe serverNow={first} />);
    });
    // Still 0: the second render's serverNow is === the mount value, no change.
    assert.equal(view.getByTestId("out").textContent, "0");
  });

  test("keeps the previous value when serverNow goes null", (t) => {
    const view = render(<Probe serverNow={null} />);
    t.after(() => cleanup());
    const next = new Date(Date.now() - 3000).toISOString();
    const expected = Date.parse(next) - Date.now();
    act(() => {
      view.rerender(<Probe serverNow={next} />);
    });
    act(() => {
      view.rerender(<Probe serverNow={null} />);
    });
    const got = Number(view.getByTestId("out").textContent);
    assert.ok(Math.abs(got - expected) <= 50, `expected ~${expected} (unchanged), got ${got}`);
  });
});
