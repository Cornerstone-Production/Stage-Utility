// timer-card.test.tsx — the Timer card says so when Finish could not save.
//
// BaptismState.saveError is set when the write behind Finish rejects (see
// baptism-save-error.test.ts for the server half). This proves the card renders
// it: a note announced as an alert, naming the reason, and saying where the
// session still exists. Without it the readout says "Finished" over a session
// Past sessions will never list.
//
// NOT proved here: how the note LOOKS. jsdom loads no stylesheet, so its colour,
// its border and whether it reads as an error beside the readout cannot be seen
// from a test; that is a check for a real browser.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND, for the reason
// baptism-operator-armed.test.tsx gives: node:assert inspecting a live jsdom
// element to build a failure message does not finish in any useful time.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { TimerCard } = await import("./timer-card.js");
const { TooltipProvider } = await import("../../../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** What the server puts in saveError: the reason, never a path (see saveFailureReason). */
const DISK = "ENOSPC: no space left on device";

/** A grouped session just finished: one person testified and was baptized. */
const FINISHED: BaptismState = {
  mode: "grouped",
  phase: "idle",
  personNumber: 1,
  baptismIndex: 0,
  armed: false,
  segmentStartedAt: null,
  segmentAccumMs: 0,
  sessionStartedAt: "2026-09-20T15:00:00.000Z",
  finishedAt: "2026-09-20T15:12:00.000Z",
  people: [{ testimonyMs: 95_000, baptizeMs: 41_000 }],
  pendingTestimonyMs: null,
  serviceTitle: "9am",
  serviceTypeId: "svc-1",
  planId: "plan-1",
  saveError: null,
};

/** BaptismTriggersPanel, inside the card, reads the plan and its bindings; an
 *  empty answer leaves it rendering nothing, which is all this test needs. */
const emptyFetch = (async () =>
  ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch;

async function mount(state: BaptismState): Promise<HTMLElement> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = emptyFetch;
  try {
    const view = render(
      React.createElement(TooltipProvider, null, React.createElement(TimerCard, { state, onFinished: () => {} })),
    );
    await settle();
    return view.container;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const alertText = (root: ParentNode): string | null => {
  const el = root.querySelector('[role="alert"]');
  return el ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : null;
};

test("a finished session whose save failed says it did not save, why, and where it still is", async () => {
  const root = await mount({ ...FINISHED, saveError: DISK });
  const text = alertText(root);
  assert.notEqual(text, null, "expected an alert on the card");
  assert.match(text!, /did not save/, "it says plainly that the session did not save");
  assert.ok(text!.includes(DISK), `it names the reason the write gave: ${text}`);
  assert.match(text!, /raw archive/, "it says where the session's presses still are");
});

test("a save that did not fail claims nothing", async () => {
  const root = await mount(FINISHED);
  assert.equal(alertText(root), null, "no alert when saveError is null");
});

test("the note stays up while the next session runs, since Start carries the failure", async () => {
  const root = await mount({
    ...FINISHED,
    phase: "testimony",
    finishedAt: null,
    people: [],
    segmentStartedAt: "2026-09-20T16:00:00.000Z",
    saveError: DISK,
  });
  const text = alertText(root);
  assert.notEqual(text, null, "the alert is not tied to the finished readout");
  assert.ok(text!.includes(DISK));
});
