// A toast that carries a button must not leave while the pointer is on it.
//
// The countdown is Radix's, which stops while the pointer is over the toasts or
// focus is in them. The store used to run a timer of its own beside it, and that
// one took an Undo out from under the pointer after four seconds whatever Radix
// was doing. Time is mocked (setTimeout and Date: Radix works the remaining time
// out from the clock), so nothing here waits.
//
// NOT covered here, driven in a browser instead: that a real pointer resting on
// the toast is what reaches Radix as these dispatched events.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, mock, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { Toaster, toast } = await import("./toast.js");

afterEach(() => {
  mock.timers.reset();
  cleanup();
});
after(() => unmountAndTeardown(cleanup, teardown));

const present = (text: string) => document.body.textContent?.includes(text) ?? false;
/** Radix watches the wrapper around the list, so a pointer leaving is dispatched there. */
const viewport = () => document.querySelector("ol")!;

function showToast(message: string, withAction: boolean) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  render(React.createElement(Toaster));
  act(() => {
    if (withAction) toast.info(message, { action: { label: "Undo", onSelect: () => {} } });
    else toast.info(message);
  });
  assert.ok(present(message), "the toast never appeared");
}
const advance = (ms: number) => act(() => { mock.timers.tick(ms); });

describe("a toast with a button", () => {
  test("a plain toast goes after about 4 seconds", () => {
    showToast("Plain one", false);
    advance(3_500);
    assert.ok(present("Plain one"), "a plain toast left early");
    advance(1_000);
    assert.equal(present("Plain one"), false, "a plain toast never left");
  });

  test("is shown for 8 seconds, longer than one without", () => {
    showToast("Has a button", true);
    advance(7_000);
    assert.ok(present("Has a button"), "a toast with a button left before 8 s");
    advance(1_500);
    assert.equal(present("Has a button"), false, "a toast with a button never left");
  });

  test("stays while the pointer is on it, however long, and then runs out", () => {
    showToast("Hold me", true);
    advance(3_000);
    act(() => { fireEvent.pointerMove(viewport()); });
    advance(60_000);
    assert.ok(present("Hold me"), "the toast left from under the pointer");
    act(() => { fireEvent.pointerLeave(viewport().parentElement!); });
    advance(4_000);
    assert.ok(present("Hold me"), "the countdown did not resume with the time it had left (about 5 s)");
    advance(2_000);
    assert.equal(present("Hold me"), false, "the toast never left after the pointer did");
  });

  test("stays while focus is in it", () => {
    showToast("Focus me", true);
    advance(3_000);
    act(() => { fireEvent.focusIn(viewport()); });
    advance(60_000);
    assert.ok(present("Focus me"), "the toast left while focus was in it");
  });
});

describe("the same message again", () => {
  const count = (text: string) => (document.body.textContent?.split(text).length ?? 1) - 1;

  test("refreshes the toast instead of stacking another", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    render(React.createElement(Toaster));
    act(() => {
      toast.success("Branding updated.");
      toast.success("Branding updated.");
      toast.success("Branding updated.");
    });
    assert.equal(count("Branding updated."), 1, "three identical toasts were stacked");
  });

  test("the refreshed toast is the newest, so it is the last one in the list", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    render(React.createElement(Toaster));
    act(() => {
      toast.success("First");
      toast.success("Second");
      toast.success("First");
    });
    // The store is module-wide, so earlier tests' toasts may still be ahead of these two.
    const order = [...document.querySelectorAll(".text-footnote")].map((e) => e.textContent).slice(-2);
    assert.deepEqual(order, ["Second", "First"]);
  });

  test("restarts its countdown", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    render(React.createElement(Toaster));
    act(() => toast.success("Branding updated."));
    advance(3_000);
    act(() => toast.success("Branding updated."));
    advance(3_000); // 6 s after the first, 3 s after the second
    assert.ok(present("Branding updated."), "the refreshed toast kept the first one's clock");
    advance(1_500);
    assert.equal(present("Branding updated."), false, "the refreshed toast never left");
  });

  test("a different message, a different type, or a toast with a button is its own toast", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    render(React.createElement(Toaster));
    act(() => {
      toast.success("Saved");
      toast.error("Saved");
      toast.success("Saved too");
      toast.info("Saved");
      toast.info("Saved", { action: { label: "Undo", onSelect: () => {} } });
      toast.info("Saved", { action: { label: "Undo", onSelect: () => {} } });
    });
    assert.equal(count("Saved"), 6, "toasts that are not the same were merged");
  });
});
