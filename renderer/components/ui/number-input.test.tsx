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
import { after, describe, test } from "node:test";

// Order matters here, which is why this is not a `before` hook. The DOM has to
// exist before the component module is evaluated: a hook runs after the module
// body, so a top-level `await import` of the component would happen first and
// render into nothing.
import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { fireEvent, render, screen, cleanup } = await import("@testing-library/react");
const { NumberInput, digitsNeeded } = await import("./number-input.js");

after(() => {
  cleanup();
  teardown();
});

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
    fireEvent.click(plus);
    assert.equal(calls.at(-1), 6);
    assert.equal(commits.at(-1), 6, "a stepper click is a commit");
    fireEvent.click(minus);
    assert.equal(calls.at(-1), 4, "stepping down from the prop value, not the display");
    cleanup();
  });

  test("a custom step is honoured", () => {
    const { commits } = setup({ value: 100, step: 100 });
    fireEvent.click(screen.getAllByRole("button")[1]);
    assert.equal(commits.at(-1), 200);
    cleanup();
  });

  test("stepping does not drift into floating-point noise", () => {
    // 0.1 + 0.2 is 0.30000000000000004. Written to a config file and read back,
    // that is what an operator sees in the field.
    const { commits } = setup({ value: 0.1, step: 0.2 });
    fireEvent.click(screen.getAllByRole("button")[1]);
    assert.equal(commits.at(-1), 0.3, `got ${commits.at(-1)}`);
    cleanup();
  });

  test("the steppers respect the bounds", () => {
    const { commits } = setup({ value: 10, step: 5, max: 10 });
    fireEvent.click(screen.getAllByRole("button")[1]);
    assert.equal(commits.at(-1), 10, "cannot step past max");
    cleanup();
  });

  test("a disabled field cannot be stepped", () => {
    const { calls } = setup({ value: 5, disabled: true });
    for (const b of screen.getAllByRole("button")) fireEvent.click(b);
    assert.deepEqual(calls, [], "a disabled control changed a value");
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

describe("the field is wide enough for its own numbers", () => {
  // "at numbers larger than 9 the number clips". The two steppers take 48px of
  // a fixed-width box, and `min-w-0` let flex shrink the field to nothing with
  // whatever was left — so "1000" on the transition field rendered as "1".
  //
  // Asserted on the RULE, not on a style attribute: this file does not test
  // markup, and the rule is the thing that was wrong.

  test("four digits get room for four digits", () => {
    // MAX_TRANSITION_MS is 3000, and this is the field the report came from.
    assert.equal(digitsNeeded(0, 3000), 4);
  });

  test("a bigger range gets more room still", () => {
    assert.equal(digitsNeeded(0, 86_400), 5);
  });

  test("a small range still gets a usable minimum", () => {
    // A two-character box beside two steppers reads as broken even when nothing
    // is actually clipped.
    assert.equal(digitsNeeded(0, 9), 3);
  });

  test("with no bounds at all it does not collapse", () => {
    assert.equal(digitsNeeded(undefined, undefined), 3);
  });

  test("a negative minimum is counted, sign and all", () => {
    assert.equal(digitsNeeded(-120, 10), 4);
  });
});
