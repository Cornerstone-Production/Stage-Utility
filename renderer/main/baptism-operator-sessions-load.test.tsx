// baptism-operator-sessions-load.test.tsx — proves the ONE piece of wiring
// header.test.tsx cannot reach: baptism-operator.tsx passing its OWN
// `sessionsError` state into <BaptismHeader sessionsLoadFailed={...}>. A test
// that constructs BaptismHeader directly (as header.test.tsx does throughout)
// can set that prop to whatever it likes without proving anything actually
// threads a real fetch failure into it — this file drives the real composed
// page instead, through a real failing fetch.
//
// Reads the Rebuild button's tooltip via a real focus event (Radix opens on
// focus as well as hover, and mounts its content into the DOM with
// role="tooltip" even for a disabled button in jsdom) rather than only
// checking `disabled`: a failed sessions load and a genuinely empty history
// both leave `state.serviceKey` null with no most-recent session to fall back
// on, so both disable the button for DIFFERENT reasons — only the reason text
// tells them apart, and a bare disabled/enabled check cannot fail on the bug
// this guards (baptism-operator.tsx forgetting to pass the prop through at
// all, or hard-coding it, would leave the button disabled either way).

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();
class FakeEventSource {
  readyState = 1;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { TooltipProvider } = await import("../components/ui/index.js");
const { BaptismOperator } = await import("./baptism-operator.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const IDLE_NO_KEY: BaptismState = {
  mode: "grouped", phase: "idle", personNumber: 0, baptismIndex: 0, armed: false,
  segmentStartedAt: null, segmentAccumMs: 0, sessionStartedAt: null, finishedAt: null,
  people: [], pendingTestimonyMs: null, serviceTitle: null, serviceTypeId: null, planId: null, serviceKey: null,
};

function stubFetch(sessionsOk: boolean) {
  return (async (input: string) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
    if (url.endsWith("/api/baptism")) return ok(IDLE_NO_KEY);
    if (url.endsWith("/api/baptism/sessions")) {
      if (sessionsOk) return ok([]);
      return { ok: false, status: 500, json: async () => ({ error: "boom" }), text: async () => '{"error":"boom"}' };
    }
    return ok({});
  }) as unknown as typeof fetch;
}

async function mount(sessionsOk: boolean) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(sessionsOk);
  const view = render(React.createElement(TooltipProvider, null, React.createElement(BaptismOperator)));
  await settle();
  await settle();
  await settle();
  return { view, restore: () => { globalThis.fetch = realFetch; } };
}

function rebuildButton(root: ParentNode): HTMLButtonElement {
  const btn = [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Rebuild from raw"));
  assert.ok(btn, "expected a Rebuild from raw button");
  return btn as HTMLButtonElement;
}

async function tooltipTextOf(btn: HTMLElement): Promise<string> {
  fireEvent.focus(btn);
  await act(async () => {
    await settle();
    await settle();
  });
  const content = document.querySelector('[role="tooltip"]');
  const shown = (content?.textContent ?? "").replace(/\s+/g, " ").trim();
  fireEvent.blur(btn);
  await act(async () => {
    await settle();
  });
  return shown;
}

test("a genuinely empty history (sessions load OK, nothing recorded) gets its own reason", async () => {
  const { view, restore } = await mount(true);
  try {
    const btn = rebuildButton(view.container);
    assert.equal(btn.disabled, true);
    const shown = await tooltipTextOf(btn);
    assert.match(shown, /Nothing has been recorded/, `expected the empty-history reason, got: ${shown}`);
  } finally {
    restore();
  }
});

test("a failed sessions load reaches the header as sessionsLoadFailed, with its OWN reason — not the empty-history one", async () => {
  const { view, restore } = await mount(false);
  try {
    const btn = rebuildButton(view.container);
    assert.equal(btn.disabled, true, "a failed load must still disable the action");
    const shown = await tooltipTextOf(btn);
    assert.match(shown, /could not be loaded/, `expected the load-failure's own reason, got: ${shown}`);
    assert.notEqual(shown, "Nothing has been recorded yet — there is no service to rebuild", "a load failure must not read as a genuinely empty history");
  } finally {
    restore();
  }
});
