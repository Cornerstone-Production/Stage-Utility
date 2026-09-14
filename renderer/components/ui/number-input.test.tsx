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
import { after, beforeEach, describe, mock, test } from "node:test";

// Order matters here, which is why this is not a `before` hook. The DOM has to
// exist before the component module is evaluated: a hook runs after the module
// body, so a top-level `await import` of the component would happen first and
// render into nothing.
import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { fireEvent, render, screen, cleanup } = await import("@testing-library/react");
// Only for the one controlled test below. Dynamic like the rest of this file's
// imports so nothing is evaluated before installDom() has run.
const { useState } = await import("react");
const { NumberInput, STEPPER_REPEAT_DELAY_MS, STEPPER_REPEAT_INTERVAL_MS } = await import("./number-input.js");

// Every test below also calls cleanup() on its way out, which is fine and
// idempotent. This is for the way out it does NOT take: a failing assertion
// throws past its own cleanup, leaving a mounted field behind, and every
// later test then dies on "Found multiple elements with the text of: test
// field" instead of on its own assertion. A red proof has to be readable.
beforeEach(() => {
  cleanup();
});

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

/** Render with a spy for onChange, and a way to read the last committed value.
 *
 *  `"value" in props`, not `props.value ?? 5`: `null` is a value this component
 *  now takes a real position on, and `??` would have quietly turned every
 *  unset-field test into a test of the number 5. */
function setup(props: Partial<React.ComponentProps<typeof NumberInput>> = {}) {
  const calls: number[] = [];
  const commits: number[] = [];
  const unsets: true[] = [];
  render(
    <NumberInput
      value={"value" in props ? (props.value as number | null) : 5}
      onChange={(v) => calls.push(v)}
      onCommit={(v) => commits.push(v)}
      aria-label="test field"
      {...props}
      // After the spread, so a test that opts in by passing its own onUnset
      // still gets counted here. A test that does NOT pass one gets no onUnset
      // at all, which is the opt-out the component's whole contract rests on.
      {...(props.onUnset
        ? {
            onUnset: () => {
              unsets.push(true);
              props.onUnset?.();
            },
          }
        : {})}
    />,
  );
  const field = screen.getByLabelText("test field") as HTMLInputElement;
  return { field, calls, commits, unsets, last: () => calls.at(-1) };
}

/** An opt-in `onUnset` for the tests below that need one but do not care what
 *  it does — `setup` wraps it and counts the calls. */
const OPT_IN = () => {};

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

// A field where BLANK is a setting, not a missing value.
//
// Three integration fields mean "no value" — a ProPresenter poll interval that
// falls back to the poller's own 1000ms, a Ross TSL port that simply is not
// configured yet, and a SenSource attendance interval that means "same as the
// Vea poll interval". All three rendered `0`, and every path out of that 0
// committed it: a click in and a click out ran the blur clamp and wrote `min`,
// and a stepper press stepped from zero.
//
// NOT UNIT-TESTED HERE, and checked in a browser instead (headless Chrome over
// CDP, against a real server on a copied data dir):
//
//   - that the empty box actually LOOKS empty and shows its placeholder in the
//     placeholder colour. jsdom loads no stylesheet and paints nothing, so the
//     `placeholder` assertion below is only that the attribute reached the DOM.
//   - that the hint string fits the 176px field rather than being clipped.
//     jsdom reports every width as 0.
describe("NumberInput, when blank is a real setting", () => {
  test("no value renders an empty box, not 0", () => {
    const { field } = setup({ value: null, onUnset: OPT_IN });
    assert.equal(field.value, "", "an unset field rendered a number the operator never set");
    cleanup();
  });

  test("NaN renders empty too", () => {
    // How the absent value used to ARRIVE here: initialConfig's fallback ladder
    // produced NaN for a field whose placeholder was prose, and String(NaN)
    // went through the same `: 0` branch a null did.
    const { field } = setup({ value: NaN, onUnset: OPT_IN });
    assert.equal(field.value, "");
    cleanup();
  });

  test("the placeholder is what the empty box carries", () => {
    const { field } = setup({ value: null, onUnset: OPT_IN, placeholder: "Same as poll interval" });
    assert.equal(field.getAttribute("placeholder"), "Same as poll interval");
    cleanup();
  });

  test("without onUnset, no value still renders 0 — the opt-in is the callback", () => {
    // The reason this is a callback and not a boolean. Twenty-odd call sites
    // pass neither, and a default-on empty state would have blanked numeric
    // fields across every settings panel in the app.
    const { field } = setup({ value: null });
    assert.equal(field.value, "0", "the unset rendering leaked to a caller that never asked for it");
    cleanup();
  });

  test("clearing reports unset on the keystroke, not saved up for blur", () => {
    // Not a nicety. A form's Save button is disabled until something reports a
    // change, and a DISABLED button does not take the mousedown that would have
    // blurred this field — so a clearing held back until blur left the operator
    // with an empty box, a greyed-out Save, and no gesture that would commit it.
    const { field, calls, unsets } = setup({ value: 30, onUnset: OPT_IN });
    fireEvent.change(field, { target: { value: "" } });
    assert.equal(unsets.length, 1, "the clearing waited for a blur that a disabled Save button never causes");
    assert.deepEqual(calls, [], "clearing the field reported a number");
    cleanup();
  });

  test("a click in and a click out of an unset field invents no number", () => {
    // THE FAILURE THAT COSTS SOMETHING. On the old blur path an unset field
    // showing 0 parsed that 0, clamped it up to `min`, and handed the caller a
    // poll interval nobody chose — which the next save of the card for any
    // other reason then wrote to disk.
    const { field, calls, commits } = setup({ value: null, onUnset: OPT_IN, min: 10, max: 3600 });
    fireEvent.focus(field);
    fireEvent.blur(field);
    assert.deepEqual(calls, [], `a focus and a blur reported ${calls}`);
    assert.deepEqual(commits, [], `a focus and a blur committed ${commits}`);
    assert.equal(field.value, "", "the field did not stay empty");
    cleanup();
  });

  test("blurring a box the operator emptied leaves it empty", () => {
    const { field, calls, commits, unsets } = setup({ value: 30, onUnset: OPT_IN, min: 10 });
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    assert.equal(field.value, "", "the field sprang back to a number");
    assert.deepEqual(calls, [], "a cleared field reported a number");
    assert.deepEqual(commits, [], "a cleared field committed a number");
    assert.ok(unsets.length >= 1, "the caller was never told the field is now empty");
    cleanup();
  });

  test("without onUnset, blurring an emptied box still springs back", () => {
    // The old behaviour, pinned. A field that must hold a number cannot be left
    // holding nothing, and this is the branch that puts the number back.
    const { field, commits } = setup({ value: 30, min: 10 });
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    assert.equal(field.value, "30");
    assert.deepEqual(commits, [30]);
    cleanup();
  });

  test("junk typed into an unset field leaves it unset", () => {
    // Junk is not an answer, so it reverts to the value — and where the value is
    // itself absent, reverting IS going back to empty. Without the `value == null`
    // half of the blur guard this committed 0.
    const { field, calls, commits } = setup({ value: null, onUnset: OPT_IN, min: 10 });
    fireEvent.change(field, { target: { value: "abc" } });
    fireEvent.blur(field);
    assert.equal(field.value, "", "junk on a blank field left something behind");
    assert.deepEqual(calls, []);
    assert.deepEqual(commits, [], `junk on a blank field committed ${commits}`);
    cleanup();
  });

  test("junk typed over a real value still reverts to that value", () => {
    // Unsettable does NOT mean "any nonsense clears it". Only an empty box does.
    const { field, commits } = setup({ value: 30, onUnset: OPT_IN, min: 10 });
    fireEvent.change(field, { target: { value: "abc" } });
    fireEvent.blur(field);
    assert.equal(field.value, "30", "a typo cleared a field that had a value");
    assert.deepEqual(commits, [30]);
    cleanup();
  });

  test("a stepper on an unset field lands on the floor, not a step above it", () => {
    // There is no number to step FROM, so the first press lands on `clamp(0)` —
    // the smallest value the field permits.
    //
    // `step: 100` against `min: 10` ON PURPOSE, and this is the whole reason the
    // case is spelled this way: with the app's own three fields (min 200/1/10,
    // step 1) `clamp(0)` and `clamp(0 + step)` give the SAME answer, so a test
    // using those numbers passes whichever expression the component holds and
    // guards nothing. A step larger than the floor is the smallest case that
    // tells them apart — `0 + step` is 100 here for a press that was asking for
    // the smallest value there is.
    const up = setup({ value: null, onUnset: OPT_IN, min: 10, max: 3600, step: 100 });
    tap(screen.getAllByRole("button")[1]);
    assert.equal(up.commits.at(-1), 10, "stepping up from blank overshot the floor");
    cleanup();

    // Down from blank stops at the floor too. Not a distinguishing case on its
    // own — `clamp(0 - 100)` is also 10 — so the negative half is pinned by the
    // no-floor test below, where `0 - step` really can escape.
    const down = setup({ value: null, onUnset: OPT_IN, min: 10, max: 3600, step: 100 });
    tap(screen.getAllByRole("button")[0]);
    assert.equal(down.commits.at(-1), 10, "stepping down from blank went below the floor");
    cleanup();
  });

  test("a second stepper press carries on from the first", () => {
    // The landing is only for the press that has nothing to step from. Once
    // there is a number, the steppers are the steppers.
    //
    // CONTROLLED, unlike every test above it, and it has to be: `startRepeat`
    // re-seeds its running value from the `value` PROP at the start of every
    // press, on purpose, so a press always steps from wherever the field
    // actually is. Held at a fixed `value={null}` this field is blank again by
    // the second press and lands on the floor twice — which is the component
    // behaving correctly for a caller that ignored its onChange, not a bug.
    const commits: number[] = [];
    function Controlled() {
      const [v, setV] = useState<number | null>(null);
      return (
        <NumberInput
          value={v}
          onChange={setV}
          onCommit={(n) => commits.push(n)}
          onUnset={() => setV(null)}
          min={10}
          max={3600}
          step={100}
          aria-label="test field"
        />
      );
    }
    render(<Controlled />);
    const [, plus] = screen.getAllByRole("button");
    tap(plus);
    tap(plus);
    // `step: 100` for the same reason the floor test above uses it: at the
    // default step of 1 this sequence is [10, 11] whether the landing is
    // `clamp(0)` or `clamp(0 + step)`, so the test could not fail on the thing
    // it is named for. At 100 the two diverge on the FIRST press — [10, 110]
    // against [100, 200] — and a landing that wrongly applied to every press
    // would read [10, 10].
    assert.deepEqual(commits, [10, 110]);
    assert.equal((screen.getByLabelText("test field") as HTMLInputElement).value, "110");
    cleanup();
  });

  test("a stepper on an unset field with no floor lands on zero, either way", () => {
    // BOTH directions, and the `-` half is the one that costs something: with no
    // floor to clamp against, `0 - step` is -1, and a negative is exactly what
    // ross-tsl.port could not have — getRossTslConfig discards anything not > 0
    // in silence while the card still reads as configured. That field has a
    // `min: 1` now, but the component must not depend on every future unsettable
    // field remembering to declare one.
    const up = setup({ value: null, onUnset: OPT_IN });
    tap(screen.getAllByRole("button")[1]);
    assert.equal(up.commits.at(-1), 0, "stepping up from blank with no floor invented a number");
    cleanup();

    const down = setup({ value: null, onUnset: OPT_IN });
    tap(screen.getAllByRole("button")[0]);
    assert.equal(down.commits.at(-1), 0, "stepping down from blank with no floor went negative");
    cleanup();
  });

  test("a stepper on an unset field with a NEGATIVE floor lands on zero, not the floor", () => {
    // `clamp(0)`, not `clamp(min ?? 0)` — the two agree for every non-negative
    // floor, which is every unsettable field the app ships, and diverge here.
    // These are the real bounds of the automation `offsetMinutes` param
    // (min -720, max 720, reached through rule-editor-dialog): blank means "no
    // offset", and the press that has nothing to step from should land on no
    // offset rather than twelve hours before the cue. That param does not opt in
    // today, so this is the component's contract rather than a shipped path.
    const { commits } = setup({ value: null, onUnset: OPT_IN, min: -720, max: 720 });
    tap(screen.getAllByRole("button")[1]);
    assert.equal(commits.at(-1), 0, "stepping up from blank landed on a negative floor");
    cleanup();
  });

  test("without onUnset, a stepper on a non-number still steps from 0", () => {
    // The landing-on-`min` rule is opt-in too, not just the empty rendering.
    // "Not a number" is reachable for a caller that never asked for any of this:
    // rule-editor-dialog spells its value `Number(value ?? spec.min ?? 0)`,
    // which is NaN for a param holding a non-numeric string. That caller keeps
    // `0 + step` — clamped to 10 here — rather than silently changing which
    // number it recovers to.
    const { commits } = setup({ value: NaN, min: 10, max: 3600 });
    tap(screen.getAllByRole("button")[1]);
    assert.equal(commits.at(-1), 10, "clamp(0 + 1) is 10, the same as before");
    cleanup();

    // And with no floor at all it is `0 + step`, not 0.
    const free = setup({ value: NaN });
    tap(screen.getAllByRole("button")[1]);
    assert.equal(free.commits.at(-1), 1, "a caller that did not opt in kept 0 + step");
    cleanup();
  });

  test("typing a number into an unset field reports the number", () => {
    const { field, calls, unsets } = setup({ value: null, onUnset: OPT_IN, min: 10, max: 3600 });
    fireEvent.change(field, { target: { value: "45" } });
    assert.deepEqual(calls, [45]);
    assert.deepEqual(unsets, [], "setting a value reported unset as well");
    cleanup();
  });
});
