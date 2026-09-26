// The Transcription widget's Lines field says what the widget does.
//
// An unset cap is how every Rolling widget is created, and the renderer shows as
// many lines as the box holds for it. The field used to fill that gap with 3, a
// number the widget never used, and once changed it could not go back to fitting.
// Driven through the real themed number field, so what is asserted is what the
// operator sees and what a keystroke sends.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { TranscriptLinesRow } = await import("./inspector.js");

after(() => teardown());
afterEach(() => cleanup());

type Strip = { type: "transcript-strip"; mode: "rolling"; maxLines?: number };

function mount(c: Strip) {
  const sent: Strip[] = [];
  const view = render(React.createElement(TranscriptLinesRow, { c, onConfig: (next: unknown) => sent.push(next as Strip) } as never));
  const input = view.container.querySelector("input") as HTMLInputElement;
  return { input, sent };
}

describe("the Transcription widget's Lines field", () => {
  test("an unset cap reads Fit, not a number the widget does not use", () => {
    const { input } = mount({ type: "transcript-strip", mode: "rolling" });
    assert.equal(input.value, "", `the field showed ${JSON.stringify(input.value)} for a cap that is not set`);
    assert.equal(input.placeholder, "Fit");
  });

  test("a set cap shows its number", () => {
    const { input } = mount({ type: "transcript-strip", mode: "rolling", maxLines: 4 });
    assert.equal(input.value, "4");
  });

  test("clearing the field goes back to fitting", () => {
    const { input, sent } = mount({ type: "transcript-strip", mode: "rolling", maxLines: 4 });
    fireEvent.change(input, { target: { value: "" } });
    assert.ok(sent.length > 0, "clearing the field sent nothing");
    assert.equal(sent.at(-1)!.maxLines, undefined, "clearing kept a cap");
  });

  test("typing a number sets the cap", () => {
    const { input, sent } = mount({ type: "transcript-strip", mode: "rolling" });
    fireEvent.change(input, { target: { value: "5" } });
    assert.equal(sent.at(-1)!.maxLines, 5);
  });
});
