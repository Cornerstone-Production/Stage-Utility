// The A- [ 100% ] A+ control in the ScriptView page's header, driven through the
// real component: the buttons step, the percentage is a field, and what is
// typed in it commits, clamps or reverts. The arithmetic itself is pinned in
// scriptview-text-size.test.ts; this proves the control is wired to it.
//
// NOT asserted here, because jsdom loads no stylesheet and does no layout: that
// the rundown actually grows, and that the header does not. Those were driven in
// a browser (see the PR). NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { TextSizeControl } = await import("./scriptview-text-size-control.js");
const { TooltipProvider } = await import("../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(cleanup);

/** The control with its size held in state, as the page holds it. `committed`
 *  records every size the control asked for, in order. */
function mount(initial = 100) {
  const committed: number[] = [];
  function Host() {
    const [size, setSize] = React.useState(initial);
    return React.createElement(
      TooltipProvider,
      null,
      React.createElement(TextSizeControl, {
        size,
        onChange: (n: number) => {
          committed.push(n);
          setSize(n);
        },
      }),
    );
  }
  render(React.createElement(Host));
  return committed;
}

const field = () => screen.getByLabelText("Text size, percent") as HTMLInputElement;
const shown = () => field().value;

/** Click the field, type, and leave it with `key` (Enter commits, Escape reverts)
 *  or by blurring. Real focus, because the commit is the field losing it. */
async function type(text: string, how: "Enter" | "Escape" | "blur"): Promise<void> {
  const input = field();
  await act(async () => input.focus());
  await act(async () => void fireEvent.change(input, { target: { value: text } }));
  if (how === "blur") await act(async () => input.blur());
  else await act(async () => void fireEvent.keyDown(input, { key: how }));
}

test("it opens at the size it was given", () => {
  mount(150);
  assert.equal(shown(), "150%");
});

test("A+ and A- step by ten, and an off-grid size lands on the next multiple of ten", async () => {
  const committed = mount(137);
  await act(async () => void fireEvent.click(screen.getByLabelText("Larger text")));
  assert.deepEqual(committed, [140]);
  await act(async () => void fireEvent.click(screen.getByLabelText("Smaller text")));
  await act(async () => void fireEvent.click(screen.getByLabelText("Smaller text")));
  assert.deepEqual(committed, [140, 130, 120]);
  assert.equal(shown(), "120%");
});

test("the steppers stop being pressable at 50 and 300", () => {
  mount(50);
  assert.equal((screen.getByLabelText("Smaller text") as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByLabelText("Larger text") as HTMLButtonElement).disabled, false);
  cleanup();
  mount(300);
  assert.equal((screen.getByLabelText("Larger text") as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByLabelText("Smaller text") as HTMLButtonElement).disabled, false);
});

test("clicking the percentage turns it into the bare number", async () => {
  mount(120);
  await act(async () => field().focus());
  assert.equal(shown(), "120");
});

test("Enter commits what was typed, rounded", async () => {
  const committed = mount();
  await type("137.6", "Enter");
  assert.deepEqual(committed, [138]);
  assert.equal(shown(), "138%");
});

test("leaving the field commits it too", async () => {
  const committed = mount();
  await type("80", "blur");
  assert.deepEqual(committed, [80]);
  assert.equal(shown(), "80%");
});

test("a typed size is held between 50 and 300", async () => {
  const committed = mount();
  await type("10", "Enter");
  await type("9000", "Enter");
  assert.deepEqual(committed, [50, 300]);
});

test("Escape puts the old size back and commits nothing", async () => {
  const committed = mount(120);
  await type("200", "Escape");
  assert.deepEqual(committed, []);
  assert.equal(shown(), "120%");
});

test("text that is not a number reverts and commits nothing", async () => {
  const committed = mount(120);
  await type("abc", "Enter");
  await type("150abc", "blur");
  assert.deepEqual(committed, []);
  assert.equal(shown(), "120%");
});
