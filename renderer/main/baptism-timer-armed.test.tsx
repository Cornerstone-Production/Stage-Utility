// The baptism-timer LAYOUT OBJECT — the stage display, not the operator panel —
// used to render 0:00 over "Baptism 1" while a grouped session was armed: the
// song had gone live, the phase was "baptism", but nobody had pressed yet. That
// is indistinguishable from a baptism that has actually just started, which is
// the exact ambiguity the operator panel's "Baptisms · armed" readout exists to
// rule out. The object receives the same `BaptismState` and never read `armed`.
//
// Rendered rather than read out of source: a text scan for "armed" would pass on
// the operator panel's own string sitting fifty lines away in the same file.
//
// NOT covered here: layout, font sizing and the CSS composition Readout draws —
// jsdom loads no stylesheet and reports every offsetHeight as 0, so the value
// prop's shrink-to-fit and the box's measured height are unverifiable here. What
// is checked is the one thing jsdom answers honestly: which text this object
// hands to the DOM for an armed state versus a running one.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

// ObjectContent reaches other layout objects' hooks that open a stream on
// branches this test does not exercise; give them a stream that does nothing.
class NoStream {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

after(() => {
  cleanup();
  teardown();
});

const BASE_STATE: BaptismState = {
  mode: "grouped",
  phase: "baptism",
  personNumber: 3,
  baptismIndex: 0,
  segmentStartedAt: null,
  segmentAccumMs: 0,
  armed: false,
  sessionStartedAt: "2026-09-20T12:00:00.000Z",
  finishedAt: null,
  people: [
    { testimonyMs: 60_000, baptizeMs: 0 },
    { testimonyMs: 45_000, baptizeMs: 0 },
    { testimonyMs: 30_000, baptizeMs: 0 },
  ],
  pendingTestimonyMs: null,
  serviceTitle: null,
  serviceTypeId: null,
  planId: null,
};

/** Render one of the baptism-timer object's fields over a given state and
 *  return the text it drew. No `label` override — the object falls back to
 *  its own wording, the branch these bugs live in. */
function textForField(state: BaptismState, field: "live" | "count" | "total" | "average" | "last" = "live"): string {
  cleanup();
  const ctx = makeRenderCtx({ baptism: state });
  const obj = {
    id: "o1",
    x: 0, y: 0, w: 0.3, h: 0.2, z: 1,
    config: { type: "baptism-timer", field, showLabel: true },
    style: {},
  } as never;
  const { container } = render(React.createElement(ObjectContent as never, { o: obj, ctx }));
  return container.textContent ?? "";
}

const textFor = (state: BaptismState) => textForField(state, "live");

describe("the baptism-timer object while armed", () => {
  test("says armed, not a person/baptism number", () => {
    const text = textFor({ ...BASE_STATE, armed: true });
    assert.ok(text.includes("armed"), `armed state did not say so. Saw: ${JSON.stringify(text)}`);
    assert.ok(
      !text.includes("Baptism 1"),
      `armed read as an already-started baptism. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("still shows 0:00 — armed has no clock running", () => {
    const text = textFor({ ...BASE_STATE, armed: true });
    assert.ok(text.includes("0:00"), `Saw: ${JSON.stringify(text)}`);
  });

  test("a genuinely running baptism still names the person", () => {
    // The fix must not swallow the ordinary case: armed is a phase of ONE
    // instant, and every baptism after the first press has to keep saying
    // which person it is.
    const text = textFor({ ...BASE_STATE, armed: false, segmentStartedAt: "2026-09-20T12:05:00.000Z" });
    assert.ok(text.includes("Baptism 1"), `Saw: ${JSON.stringify(text)}`);
    assert.ok(!text.includes("armed"), `Saw: ${JSON.stringify(text)}`);
  });
});

describe("the baptism-timer object's \"last\" field", () => {
  // In grouped mode every testimony is pushed into `people` up front with
  // `baptizeMs: 0`, then mutated in place as each baptism happens — so the
  // LAST entry in `people` is the last person who testified, not the last one
  // baptized. They only agree on the final baptism of the session.

  test("mid-testimony, nobody baptized yet, shows the dash — not a testimony time", () => {
    // BASE_STATE: three testimonies done, phase "baptism" not yet reached in
    // spirit (baptismIndex 0, every baptizeMs still 0). people[length-1]'s own
    // testimonyMs (30_000 -> "0:30") is exactly what the bug rendered here.
    const text = textForField(BASE_STATE, "last");
    assert.ok(text.includes("—"), `Saw: ${JSON.stringify(text)}`);
    assert.ok(!text.includes("0:30"), `named a testimony instead of nobody. Saw: ${JSON.stringify(text)}`);
  });

  test("partway through the baptisms, names the person actually just baptized", () => {
    // Person 0 baptized (25s), person 1 and 2 still only testified. The last
    // entry in `people` is person 2 (testimony 30s, baptizeMs 0) — the bug
    // would report 0:30 (testimony-only) instead of person 0's 1:25 total.
    const state: BaptismState = {
      ...BASE_STATE,
      baptismIndex: 1,
      people: [
        { testimonyMs: 60_000, baptizeMs: 25_000 },
        { testimonyMs: 45_000, baptizeMs: 0 },
        { testimonyMs: 30_000, baptizeMs: 0 },
      ],
    };
    const text = textForField(state, "last");
    assert.ok(text.includes("1:25"), `did not name the person actually baptized. Saw: ${JSON.stringify(text)}`);
    assert.ok(!text.includes("0:30"), `named the last TESTIFIED person instead. Saw: ${JSON.stringify(text)}`);
  });
});
