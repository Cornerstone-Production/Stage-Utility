// The baptism-timer LAYOUT OBJECT's four new fields: testimony, session, phase
// and person. See baptism-timer-armed.test.tsx for the existing "live"/"last"
// field coverage and why armed needs its own proof — the same ambiguity (a
// frozen 0:00 reading as an active clock) is exactly what `phase` and `person`
// must not reintroduce for a person number.
//
// NOT covered here: layout, font sizing and the CSS composition Readout draws —
// jsdom loads no stylesheet and reports every offsetHeight as 0, so the value
// prop's shrink-to-fit and the box's measured height are unverifiable here. What
// is checked is the one thing jsdom answers honestly: which text this object
// hands to the DOM for a given state.

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

type Field = "testimony" | "session" | "phase" | "person";

const IDLE: BaptismState = {
  mode: "grouped",
  phase: "idle",
  personNumber: 0,
  baptismIndex: 0,
  segmentStartedAt: null,
  segmentAccumMs: 0,
  armed: false,
  sessionStartedAt: null,
  finishedAt: null,
  people: [],
  pendingTestimonyMs: null,
  serviceTitle: null,
  serviceTypeId: null,
  planId: null,
};

/** Render one field over a given state (and shared "now"), returning the text
 *  it drew. No `label` override — the object falls back to its own wording. */
function textForField(state: BaptismState, field: Field, now = 0): string {
  cleanup();
  const ctx = makeRenderCtx({ baptism: state, now });
  const obj = {
    id: "o1",
    x: 0, y: 0, w: 0.3, h: 0.2, z: 1,
    config: { type: "baptism-timer", field, showLabel: true },
    style: {},
  } as never;
  const { container } = render(React.createElement(ObjectContent as never, { o: obj, ctx }));
  return container.textContent ?? "";
}

describe("idle — nothing to show yet", () => {
  // "phase" is excluded: idle is one of its four real values (idle / armed /
  // testimony / baptism), not an absence of one — it reads the word "idle",
  // covered below instead of the dash every other field falls back to.
  for (const field of ["testimony", "session", "person"] as const) {
    test(`${field} reads the dash`, () => {
      const text = textForField(IDLE, field);
      assert.ok(text.includes("—"), `Saw: ${JSON.stringify(text)}`);
    });
  }
});

describe("phase", () => {
  test("says idle before a session has started", () => {
    const text = textForField(IDLE, "phase");
    assert.ok(text.includes("idle"), `Saw: ${JSON.stringify(text)}`);
  });

  test("says testimony during the testimony phase", () => {
    const text = textForField({ ...IDLE, phase: "testimony", personNumber: 1 }, "phase");
    assert.ok(text.includes("testimony"), `Saw: ${JSON.stringify(text)}`);
  });

  test("says baptism while a baptism is running", () => {
    const state: BaptismState = {
      ...IDLE,
      phase: "baptism",
      personNumber: 3,
      people: [{ testimonyMs: 60_000, baptizeMs: 0 }],
      segmentStartedAt: "2026-09-20T12:00:00.000Z",
    };
    const text = textForField(state, "phase");
    assert.ok(text.includes("baptism"), `Saw: ${JSON.stringify(text)}`);
  });

  test("says armed rather than baptism while armed — the same ambiguity 'live' already guards", () => {
    const state: BaptismState = {
      ...IDLE,
      phase: "baptism",
      armed: true,
      personNumber: 7,
      people: Array.from({ length: 7 }, () => ({ testimonyMs: 60_000, baptizeMs: 0 })),
    };
    const text = textForField(state, "phase");
    assert.ok(text.includes("armed"), `Saw: ${JSON.stringify(text)}`);
    assert.ok(!text.includes("baptism"), `armed read as an active baptism. Saw: ${JSON.stringify(text)}`);
  });
});

describe("person", () => {
  test("testimony phase shows the testimony person's number, in either mode", () => {
    const text = textForField({ ...IDLE, phase: "testimony", personNumber: 3, mode: "grouped" }, "person");
    assert.ok(text.includes("Person 3"), `Saw: ${JSON.stringify(text)}`);
    assert.ok(!text.includes("of"), `testimony has no total yet. Saw: ${JSON.stringify(text)}`);
  });

  test("grouped baptism phase reads N of M once the testimony pass has run", () => {
    // 7 testimonies banked (the testimony pass is done); baptizing person 3
    // (0-based index 2).
    const state: BaptismState = {
      ...IDLE,
      mode: "grouped",
      phase: "baptism",
      personNumber: 7, // frozen testimony counter — must NOT leak into "N of M"
      baptismIndex: 2,
      people: Array.from({ length: 7 }, (_, i) => ({ testimonyMs: 60_000 + i, baptizeMs: i < 2 ? 30_000 : 0 })),
      segmentStartedAt: "2026-09-20T12:00:00.000Z",
    };
    const text = textForField(state, "person");
    assert.ok(text.includes("3 of 7"), `Saw: ${JSON.stringify(text)}`);
  });

  test("per-person mode has no 'of M', even mid-baptism", () => {
    const state: BaptismState = {
      ...IDLE,
      mode: "per-person",
      phase: "baptism",
      personNumber: 2,
      pendingTestimonyMs: 90_000,
      segmentStartedAt: "2026-09-20T12:00:00.000Z",
    };
    const text = textForField(state, "person");
    assert.ok(text.includes("Person 2"), `Saw: ${JSON.stringify(text)}`);
    assert.ok(!text.includes("of"), `Saw: ${JSON.stringify(text)}`);
  });

  test("armed says armed, never a person number that reads as an active baptism", () => {
    const state: BaptismState = {
      ...IDLE,
      mode: "grouped",
      phase: "baptism",
      armed: true,
      personNumber: 7,
      baptismIndex: 0,
      people: Array.from({ length: 7 }, () => ({ testimonyMs: 60_000, baptizeMs: 0 })),
    };
    const text = textForField(state, "person");
    assert.ok(text.includes("armed"), `Saw: ${JSON.stringify(text)}`);
    assert.ok(!text.includes("1 of 7"), `armed read as person 1 already baptizing. Saw: ${JSON.stringify(text)}`);
  });
});

describe("testimony — this person's banked testimony", () => {
  test("ticks locally while their testimony is running, the same way 'live' does", () => {
    const state: BaptismState = {
      ...IDLE,
      phase: "testimony",
      personNumber: 1,
      segmentStartedAt: "2026-09-20T12:00:00.000Z",
    };
    const now = Date.parse("2026-09-20T12:00:00.000Z") + 65_000; // 1:05
    const text = textForField(state, "testimony", now);
    assert.ok(text.includes("1:05"), `Saw: ${JSON.stringify(text)}`);
  });

  test("per-person: freezes at the banked value once baptism begins, not the running baptism clock", () => {
    const state: BaptismState = {
      ...IDLE,
      mode: "per-person",
      phase: "baptism",
      personNumber: 1,
      pendingTestimonyMs: 107_000, // 1:47 — the testimony that just closed
      segmentStartedAt: "2026-09-20T12:00:00.000Z", // the BAPTISM clock, now running
    };
    const now = Date.parse("2026-09-20T12:00:00.000Z") + 38_000; // baptism running 0:38
    const text = textForField(state, "testimony", now);
    assert.ok(text.includes("1:47"), `did not show the banked testimony. Saw: ${JSON.stringify(text)}`);
    assert.ok(!text.includes("0:38"), `leaked the baptism clock instead. Saw: ${JSON.stringify(text)}`);
  });

  test("grouped: reads the CURRENT person's own banked testimony, not the last one taken", () => {
    const state: BaptismState = {
      ...IDLE,
      mode: "grouped",
      phase: "baptism",
      baptismIndex: 1,
      people: [
        { testimonyMs: 60_000, baptizeMs: 30_000 },
        { testimonyMs: 107_000, baptizeMs: 0 }, // person being baptized right now
        { testimonyMs: 45_000, baptizeMs: 0 },
      ],
      segmentStartedAt: "2026-09-20T12:00:00.000Z",
    };
    const text = textForField(state, "testimony");
    assert.ok(text.includes("1:47"), `Saw: ${JSON.stringify(text)}`);
  });
});

describe("session — wall clock since the session started, not the segment", () => {
  test("ticks from sessionStartedAt regardless of phase", () => {
    const state: BaptismState = {
      ...IDLE,
      phase: "testimony",
      personNumber: 2,
      sessionStartedAt: "2026-09-20T12:00:00.000Z",
      segmentStartedAt: "2026-09-20T12:10:00.000Z", // the segment is a different, later clock
    };
    const now = Date.parse("2026-09-20T12:00:00.000Z") + 842_000; // 14:02
    const text = textForField(state, "session", now);
    assert.ok(text.includes("14:02"), `Saw: ${JSON.stringify(text)}`);
  });

  test("keeps counting through a pause — it is the WALL clock, not the segment", () => {
    const state: BaptismState = {
      ...IDLE,
      phase: "testimony",
      personNumber: 1,
      sessionStartedAt: "2026-09-20T12:00:00.000Z",
      segmentStartedAt: null, // segment is paused
      segmentAccumMs: 5_000,
    };
    const now = Date.parse("2026-09-20T12:00:00.000Z") + 120_000; // 2:00
    const text = textForField(state, "session", now);
    assert.ok(text.includes("2:00"), `a paused segment must not freeze the session clock. Saw: ${JSON.stringify(text)}`);
  });

  test("freezes at the finished duration once the session ends, not the wall clock since", () => {
    const state: BaptismState = {
      ...IDLE,
      phase: "idle",
      finishedAt: "2026-09-20T12:14:02.000Z",
      sessionStartedAt: "2026-09-20T12:00:00.000Z",
      people: [{ testimonyMs: 60_000, baptizeMs: 30_000 }],
    };
    const now = Date.parse("2026-09-20T12:14:02.000Z") + 600_000; // long after finishing
    const text = textForField(state, "session", now);
    assert.ok(text.includes("14:02"), `did not freeze at the finished length. Saw: ${JSON.stringify(text)}`);
  });
});
