// The first component test in the project, and the pattern for the rest.
//
// It asserts BEHAVIOUR, never markup: what an operator does, and what the caller
// is told. No class names, no DOM structure, no snapshots — those break on every
// restyle and teach people to regenerate them without reading, which is worse
// than no test.
//
// NumberInput earns going first because it is the standard for every numeric
// setting in the app (poll intervals, ports, lead times, backup intervals), so a
// bug here is a bug in all of them at once. It also has real edge behaviour: a
// field you can empty mid-edit without committing a zero, clamping that must not
// fight you while typing, and floating-point steppers.

import { strict as assert } from "node:assert";
import { after, describe, mock, test } from "node:test";

// Order matters here, which is why this is not a `before` hook. The DOM has to
// exist before the component module is evaluated: a hook runs after the module
// body, so a top-level `await import` of the component would happen first and
// render into nothing.
import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { fireEvent, render, screen, cleanup } = await import("@testing-library/react");
const { NumberInput, STEPPER_REPEAT_DELAY_MS, STEPPER_REPEAT_INTERVAL_MS } = await import("./number-input.js");

after(() => {
  cleanup();
  teardown();
});

/** A press-and-release, short of the repeat delay — the one-step case every
 *  stepper click used to be a plain `fireEvent.click` for, before a hold
 *  became a distinct gesture from a tap. See number-input.tsx's `startRepeat`. */
function tap(el: Element) {
  fireEvent.pointerDown(el, { pointerId: 1, isPrimary: true });
  fireEvent.pointerUp(el, { pointerId: 1 });
}

// React's own scheduler queues its next pass with `setImmediate`, which the
// repeat tests below deliberately leave real (`mock.timers.enable` only fakes
// `setTimeout`/`setInterval`) — see context-menu-trigger.test.tsx for the same
// pattern and why. Draining it keeps a stray callback from firing after the
// DOM this file installs has already been torn down.
//
// TWICE, not once: a held stepper fires many state updates in a single test
// (up to nine `onChange`/`onCommit`/`setText` calls for the 1s-hold case),
// and React's scheduler needed a second hop to fully settle after that many —
// one `setImmediate` left a callback pending that then threw "window is not
// defined" once the DOM came down, reproduced on the max-clamp repeat test.
async function flushReact(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * `mock.timers.tick(ms)` only fires timers that exist AT THE TIME it is
 * called — a `setInterval` created by a `setTimeout` callback mid-tick does
 * not get a chance to fire within that same call, so a single
 * `tick(1000)` over a repeat that schedules its own interval from inside a
 * delay timer under-counts. Ticking in small steps gives the newly-created
 * interval a chance to be "current" for a later step within the same
 * advance. Reproduced: `tick(1000)` once reports 1 commit; stepping by 10ms
 * reports the real 8.
 */
function tickInSteps(totalMs: number, stepMs = 10) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    mock.timers.tick(Math.min(stepMs, totalMs - elapsed));
  }
}

/** Render with a spy for onChange, and a way to read the last committed value. */
function setup(props: Partial<React.ComponentProps<typeof NumberInput>> = {}) {
  const calls: number[] = [];
  const commits: number[] = [];
  render(
    <NumberInput
      value={props.value ?? 5}
      onChange={(v) => calls.push(v)}
      onCommit={(v) => commits.push(v)}
      aria-label="test field"
      {...props}
    />,
  );
  const field = screen.getByLabelText("test field") as HTMLInputElement;
  return { field, calls, commits, last: () => calls.at(-1) };
}

describe("NumberInput", () => {
  test("shows the value it was given", () => {
    const { field } = setup({ value: 42 });
    assert.equal(field.value, "42");
    cleanup();
  });

  test("typing a number reports it to the caller", () => {
    const { field, last } = setup({ value: 5 });
    fireEvent.change(field, { target: { value: "12" } });
    assert.equal(last(), 12);
    cleanup();
  });

  test("emptying the field mid-edit does NOT commit a value", () => {
    // The one that matters. Clearing to retype must not momentarily persist 0 —
    // for a poll interval that is a busy loop, for a port it is an unbindable
    // value written to disk.
    const { field, calls } = setup({ value: 500 });
    fireEvent.change(field, { target: { value: "" } });
    assert.deepEqual(calls, [], "an empty field committed something");
    cleanup();
  });

  test("junk text is ignored rather than reported as NaN", () => {
    const { field, calls } = setup({ value: 5 });
    fireEvent.change(field, { target: { value: "abc" } });
    assert.deepEqual(calls, [], "NaN reached the caller");
    cleanup();
  });

  test("a typed value is clamped to min and max", () => {
    const { field, last } = setup({ value: 5, min: 1, max: 10 });
    fireEvent.change(field, { target: { value: "99" } });
    assert.equal(last(), 10, "above max");
    fireEvent.change(field, { target: { value: "-4" } });
    assert.equal(last(), 1, "below min");
    cleanup();
  });

  test("the steppers move by one step and commit", () => {
    // Two callbacks by design: onChange for dirty-tracking, onCommit for
    // commit-on-blur callers. A stepper click is a settled value, so both fire.
    const { calls, commits } = setup({ value: 5, step: 1 });
    const [minus, plus] = screen.getAllByRole("button");
    tap(plus);
    assert.equal(calls.at(-1), 6);
    assert.equal(commits.at(-1), 6, "a stepper click is a commit");
    tap(minus);
    assert.equal(calls.at(-1), 4, "stepping down from the prop value, not the display");
    cleanup();
  });

  test("a right-click on a stepper does not step the value", () => {
    // Reproduced: a right-click on `+` bumped 5 to 6 while the browser's own
    // context menu opened on top of it — a value changed by a gesture that was
    // never asking to change anything, hidden under the very menu it opened.
    const { calls, commits } = setup({ value: 5, step: 1 });
    const [, plus] = screen.getAllByRole("button");
    fireEvent.pointerDown(plus, { pointerId: 1, button: 2, isPrimary: true });
    fireEvent.pointerUp(plus, { pointerId: 1, button: 2, isPrimary: true });
    assert.deepEqual(calls, [], "a right-click stepped the value");
    assert.deepEqual(commits, [], "a right-click committed a value");
    // The primary button still works right after — the guard only rejects the
    // other buttons, it does not wedge the control.
    tap(plus);
    assert.equal(calls.at(-1), 6);
    assert.equal(commits.at(-1), 6);
    cleanup();
  });

  test("a custom step is honoured", () => {
    const { commits } = setup({ value: 100, step: 100 });
    tap(screen.getAllByRole("button")[1]);
    assert.equal(commits.at(-1), 200);
    cleanup();
  });

  test("stepping does not drift into floating-point noise", () => {
    // 0.1 + 0.2 is 0.30000000000000004. Written to a config file and read back,
    // that is what an operator sees in the field.
    const { commits } = setup({ value: 0.1, step: 0.2 });
    tap(screen.getAllByRole("button")[1]);
    assert.equal(commits.at(-1), 0.3, `got ${commits.at(-1)}`);
    cleanup();
  });

  test("the steppers respect the bounds", () => {
    const { commits } = setup({ value: 10, step: 5, max: 10 });
    tap(screen.getAllByRole("button")[1]);
    assert.equal(commits.at(-1), 10, "cannot step past max");
    cleanup();
  });

  test("a disabled field cannot be stepped", () => {
    const { calls } = setup({ value: 5, disabled: true });
    for (const b of screen.getAllByRole("button")) tap(b);
    assert.deepEqual(calls, [], "a disabled control changed a value");
    cleanup();
  });

  test("held past the repeat delay steps more than once", async () => {
    const { commits } = setup({ value: 0, step: 1 });
    const [, plus] = screen.getAllByRole("button");

    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      fireEvent.pointerDown(plus, { pointerId: 1, isPrimary: true });
      assert.equal(commits.length, 1, "pressing down is one step by itself");
      // Held for 1s: one step on press, then the repeat interval's first
      // firing lands at STEPPER_REPEAT_DELAY_MS + STEPPER_REPEAT_INTERVAL_MS
      // (an interval fires AFTER its period elapses, not at the moment it is
      // created) and every STEPPER_REPEAT_INTERVAL_MS after that — so
      // floor((1000 - 400) / 80) = 7 repeats land inside the 1s hold, 8 steps
      // in all. Close to, not exactly, the "~1 + ceil(600/80) = 9" the touch
      // sweep spec estimated — that estimate assumed a firing at the delay
      // itself, which is not how `setInterval` behaves.
      tickInSteps(1000);
      const expectedRepeats = Math.floor((1000 - STEPPER_REPEAT_DELAY_MS) / STEPPER_REPEAT_INTERVAL_MS);
      assert.equal(commits.length, 1 + expectedRepeats, `expected ${1 + expectedRepeats} steps, got ${commits.length}`);
      // Starting from 0, step 1: the Nth commit is worth N.
      assert.equal(commits.at(-1), commits.length, "each repeat advances by exactly one step");
      fireEvent.pointerUp(plus, { pointerId: 1 });
    } finally {
      mock.timers.reset();
      await flushReact();
    }
    cleanup();
  });

  test("released before the repeat delay steps exactly once", async () => {
    const { commits } = setup({ value: 0, step: 1 });
    const [, plus] = screen.getAllByRole("button");

    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      fireEvent.pointerDown(plus, { pointerId: 1, isPrimary: true });
      mock.timers.tick(STEPPER_REPEAT_DELAY_MS - 50);
      fireEvent.pointerUp(plus, { pointerId: 1 });
      // Run out whatever time remains — a lingering timer must have been
      // cancelled by the release, not merely delayed.
      mock.timers.tick(STEPPER_REPEAT_DELAY_MS * 4);
      assert.equal(commits.length, 1, "releasing before the delay must not start repeating");
    } finally {
      mock.timers.reset();
      await flushReact();
    }
    cleanup();
  });

  test("a held stepper still clamps at max and stops advancing", async () => {
    const { commits } = setup({ value: 8, step: 1, max: 10 });
    const [, plus] = screen.getAllByRole("button");

    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      fireEvent.pointerDown(plus, { pointerId: 1, isPrimary: true });
      tickInSteps(1000);
      fireEvent.pointerUp(plus, { pointerId: 1 });
      assert.ok(commits.length >= 3, "expected multiple repeats before hitting max");
      assert.ok(
        commits.every((v) => v <= 10),
        `a held stepper stepped past max: ${commits}`,
      );
      assert.equal(commits.at(-1), 10);
    } finally {
      mock.timers.reset();
      await flushReact();
    }
    cleanup();
  });

  test("a new value from the parent is what gets displayed", () => {
    // Settings can change from another tab over SSE, so the field has to render
    // whatever it is handed rather than whatever was typed into it last.
    const first = setup({ value: 5 });
    assert.equal(first.field.value, "5");
    cleanup();

    const second = setup({ value: 250 });
    assert.equal(second.field.value, "250");
    cleanup();
  });
});
