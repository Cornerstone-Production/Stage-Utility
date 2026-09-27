// A Home card that has not heard back yet must not claim a false state.
//
// useObsStatus/useReaperStatus/useSplStatus/useScoresStatus all return
// `{ value, known }`, and RecordingCard/SplCard/ScoresCard (cards.tsx) and
// ScreensCard (readiness.ts's onlineKnown) gate their negative claims on
// `known` — see use-status-channel.ts's own header for why `value === null`
// cannot carry this on its own. Before this fix these cards read `null` the
// same way whether that meant "not yet known" or "genuinely disconnected",
// which is what made Home's cards claim "Offline" and "one or more offline"
// on the strength of nothing but their own unset default.
//
// Driven through the real cards with a stubbed fetch that never resolves —
// the honest shape of "the read is still in flight" — and, separately, one
// that resolves to a real disconnected answer, to prove the card corrects
// itself rather than staying on the placeholder forever.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { RecordingCard, SplCard, ScreensCard } = await import("./cards.js");
const { RouterContextProvider, createRootRoute, createRouter, createMemoryHistory } = await import("@tanstack/react-router");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

// ScreensCard's "Screens" reading is a router Link (to="/screens"), which
// needs a router in context — the same setup recent-services-reads.test.tsx
// uses for RecentServicesCard's "Open History" link.
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
await router.load();
function withRouter(el: React.ReactElement) {
  return React.createElement(RouterContextProvider as never, { router }, el);
}

/** Never settles — the read genuinely still in flight, never failed either. */
function pending(): Promise<never> {
  return new Promise(() => {});
}

async function mount(el: React.ReactElement) {
  const view = render(el);
  await settle();
  return view;
}

test("RecordingCard: unresolved reads render the placeholder, not Offline", async () => {
  const f = stubFetchWithLog(() => pending());
  try {
    const { container } = await mount(
      React.createElement(RecordingCard, { now: Date.now() }),
    );
    const text = container.textContent ?? "";
    assert.ok(!/Offline/.test(text), `unresolved reads must not claim Offline — got ${JSON.stringify(text)}`);
    assert.ok(!/no recorder connected/.test(text), `unresolved reads must not name a reason — got ${JSON.stringify(text)}`);
    assert.match(text, /—/, "expected the placeholder dash while unknown");
  } finally {
    f.restore();
  }
});

test("RecordingCard: once both reads answer disconnected, it correctly says Offline", async () => {
  const f = stubFetchWithLog((url) => {
    if (url.includes("/api/obs/status")) return ok({ connected: false, recording: false });
    if (url.includes("/api/reaper/status")) return ok({ connected: false, recording: false });
    return ok({});
  });
  try {
    const { container } = await mount(
      React.createElement(RecordingCard, { now: Date.now() }),
    );
    await settle();
    const text = container.textContent ?? "";
    assert.match(text, /Offline/, "a settled, genuinely disconnected answer must still read Offline");
    assert.match(text, /no recorder connected/);
  } finally {
    f.restore();
  }
});

test("SplCard: an unresolved read renders the placeholder, not Smaart offline", async () => {
  const f = stubFetchWithLog(() => pending());
  try {
    const { container } = await mount(React.createElement(SplCard, {}));
    const text = container.textContent ?? "";
    assert.ok(!/offline/i.test(text), `unresolved SPL read must not claim offline — got ${JSON.stringify(text)}`);
    assert.match(text, /—/);
  } finally {
    f.restore();
  }
});

test("ScreensCard: unknown presence renders the placeholder count, not a false offline claim", () => {
  const outputs = [
    { id: "d1", name: "Lobby", viewId: "v1" },
    { id: "d2", name: "Foyer", viewId: "v1" },
  ] as unknown as Output[];
  const { container } = render(
    withRouter(React.createElement(ScreensCard, { outputs, onlineOutputIds: [], onlineKnown: false })),
  );
  const text = container.textContent ?? "";
  assert.ok(!/one or more offline/.test(text), `unknown presence must not claim screens are offline — got ${JSON.stringify(text)}`);
  assert.match(text, /—\/2/, "expected the placeholder count while presence is unknown");
});

test("ScreensCard: control — the same empty set, once known, is a real failure", () => {
  const outputs = [
    { id: "d1", name: "Lobby", viewId: "v1" },
    { id: "d2", name: "Foyer", viewId: "v1" },
  ] as unknown as Output[];
  const { container } = render(
    withRouter(React.createElement(ScreensCard, { outputs, onlineOutputIds: [], onlineKnown: true })),
  );
  const text = container.textContent ?? "";
  assert.match(text, /one or more offline/, "a settled empty presence must still fail");
  assert.match(text, /0\/2/);
});
