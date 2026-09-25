// The action-button object. Its own actionId is opaque to a stage display —
// this is what confirms which action a press will fire, and what tells the
// operator, without pressing it, that a saved id no longer exists at all
// (the layout was built against an action that has since been removed or
// renamed).
//
// NOT unit-tested here, and checked in a browser instead: how the warning
// LOOKS. jsdom loads no stylesheet, so colour and opacity are unverifiable.
// What is checked is the one thing jsdom answers honestly: which text this
// object hands to the DOM for a given registry answer.

import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoStream {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup, waitFor, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider, useQuery } = await import("@tanstack/react-query");
const { automationRegistryQuery } = await import("../lib/automation-registry.js");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** What the registry answers for GET /api/automation/registry, for the
 *  duration of one test — restored in afterEach so tests cannot see each
 *  other's fixture. `null` fails the read; `"malformed"` answers 200 with no
 *  `actions` array, which must be treated as a failure too. */
let registryActions: { id: string; label: string }[] | null | "malformed" = [
  { id: "baptism.advance", label: "Advance the baptism timer" },
  { id: "baptism.back", label: "Step the baptism timer back" },
];
/** Every POST /api/log/client call, so a failure can be proven to actually
 *  reach the server's log rather than only the browser console. */
let logCalls: { tag: string; message: string }[] = [];
/** How many times GET /api/automation/registry was actually fetched — the
 *  count a shared react-query cache must hold at one no matter how many
 *  ActionButtons ask for it, and a private per-mount fetch would not. */
let registryFetchCount = 0;
before(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes("/api/automation/registry")) {
      registryFetchCount++;
      if (registryActions === null) throw new Error("registry unreachable");
      const body = registryActions === "malformed" ? {} : { triggers: [], conditions: [], actions: registryActions };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    if (u.includes("/api/log/client")) {
      const body = JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? "{}")) as {
        tag: string;
        message: string;
      };
      logCalls.push(body);
    }
    const body = { ok: true, detail: "" };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
});
afterEach(() => {
  registryActions = [
    { id: "baptism.advance", label: "Advance the baptism timer" },
    { id: "baptism.back", label: "Step the baptism timer back" },
  ];
  logCalls = [];
  registryFetchCount = 0;
});

function renderButton(config: { type: "action-button"; actionId: string; label?: string }) {
  const ctx = makeRenderCtx({ interactive: true });
  const obj = { id: "o1", x: 0, y: 0, w: 0.3, h: 0.2, z: 1, config, style: {} } as never;
  // A fresh client per render, like action-button-inspector.test.tsx's mount()
  // — the real app shares one across every ActionButton (that sharing is what
  // this file's own suite below proves), but a test isolating one button must
  // not carry a previous test's cached registry answer into the next.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    React.createElement(
      QueryClientProvider as never,
      { client: qc },
      React.createElement(ObjectContent as never, { o: obj, ctx }),
    ),
  );
}

describe("action-button — label", () => {
  test("an explicit label wins, before and after the registry answers", async () => {
    const { container } = renderButton({ type: "action-button", actionId: "baptism.advance", label: "ADVANCE" });
    assert.ok(container.textContent?.includes("ADVANCE"));
    await waitFor(() => assert.ok(container.textContent?.includes("ADVANCE")));
  });

  test("a blank label falls back to the action's own label once the registry answers", async () => {
    const { container } = renderButton({ type: "action-button", actionId: "baptism.advance" });
    await waitFor(() => assert.ok(container.textContent?.includes("Advance the baptism timer")));
  });

  test("a blank label with no actionId chosen still reads a plain placeholder", async () => {
    const { container } = renderButton({ type: "action-button", actionId: "" });
    await waitFor(() => assert.ok(container.textContent?.includes("Action")));
  });
});

describe("action-button — an id the registry no longer has", () => {
  test("says so plainly, rather than rendering exactly like a working button", async () => {
    const { container } = renderButton({ type: "action-button", actionId: "baptism.retired-action" });
    await waitFor(() => assert.match(container.textContent ?? "", /unknown/i));
  });

  test("a chosen id that IS in the registry never reads unknown", async () => {
    const { container } = renderButton({ type: "action-button", actionId: "baptism.advance" });
    await waitFor(() => assert.ok(container.textContent?.includes("Advance the baptism timer")));
    assert.doesNotMatch(container.textContent ?? "", /unknown/i);
  });

  test("before the registry has answered, an unfamiliar id is not yet called unknown", async () => {
    registryActions = null; // the fetch throws, so the hook never resolves
    const { container } = renderButton({ type: "action-button", actionId: "baptism.advance", label: "ADVANCE" });
    // Give the failed fetch a turn to settle, then confirm the button still
    // reads as an ordinary one — a read that failed must not brand every
    // action-button on screen as broken.
    await act(() => new Promise((r) => setTimeout(r, 10)));
    assert.doesNotMatch(container.textContent ?? "", /unknown/i);
  });

  test("no actionId chosen at all is not the same as an unknown one", async () => {
    const { container } = renderButton({ type: "action-button", actionId: "" });
    await act(() => new Promise((r) => setTimeout(r, 10)));
    assert.doesNotMatch(container.textContent ?? "", /unknown/i);
  });
});

describe("action-button — the registry itself could not be loaded", () => {
  test("says the action list could not be loaded, rather than a bare id or a silent nothing", async () => {
    registryActions = null; // GET /api/automation/registry rejects
    const { container } = renderButton({ type: "action-button", actionId: "baptism.advance", label: "ADVANCE" });
    await waitFor(() => assert.match(container.textContent ?? "", /could not be loaded/i));
  });

  test("logs the failure to the server, not only the browser console", async () => {
    registryActions = null;
    renderButton({ type: "action-button", actionId: "baptism.advance" });
    await waitFor(() => assert.ok(logCalls.length > 0, "expected a POST /api/log/client call"));
    assert.match(logCalls[0]!.message, /registry|could not/i);
  });

  test("a 200 with no actions array is treated as a failure too, not silence", async () => {
    registryActions = "malformed";
    const { container } = renderButton({ type: "action-button", actionId: "baptism.advance" });
    await waitFor(() => assert.match(container.textContent ?? "", /could not be loaded/i));
  });

  test("does not also claim the action is unknown — the two failures read differently", async () => {
    registryActions = null;
    const { container } = renderButton({ type: "action-button", actionId: "baptism.advance" });
    await waitFor(() => assert.match(container.textContent ?? "", /could not be loaded/i));
    assert.doesNotMatch(container.textContent ?? "", /unknown action/i);
  });
});

describe("action-button — sharing the registry request", () => {
  test("a panel of several buttons fetches the registry once, not once per button", async () => {
    // One client for the whole panel, the way renderer/main/index.tsx provides
    // exactly one for the real app — a QueryClientProvider per button (like
    // renderButton() above, deliberately, for test isolation) would defeat the
    // one thing this test exists to prove.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const ctx = makeRenderCtx({ interactive: true });
    const buttons = ["baptism.advance", "baptism.back", "baptism.advance"].map((actionId, i) => {
      const obj = { id: `o${i}`, x: 0, y: 0, w: 0.3, h: 0.2, z: 1, config: { type: "action-button", actionId }, style: {} } as never;
      return React.createElement(ObjectContent as never, { key: i, o: obj, ctx });
    });
    const { container } = render(
      React.createElement(QueryClientProvider as never, { client: qc }, ...buttons),
    );
    await waitFor(() => assert.ok(container.textContent?.includes("Advance the baptism timer")));
    assert.equal(registryFetchCount, 1, `expected one shared GET /api/automation/registry, saw ${registryFetchCount}`);
  });
});

// The registry's query key is shared with the action-button inspector and the
// Automation section. The button once cached the bare actions list under it
// while they cached the whole registry, so whichever mounted first handed the
// other the wrong shape: the inspector waited forever, or a layout opened with a
// button already on it crashed calling `.find` on an object.
describe("action-button — one registry shape, shared with the editors", () => {
  function RegistryReader({ onRead }: { onRead: (data: unknown) => void }) {
    const { data } = useQuery(automationRegistryQuery);
    onRead(data);
    return null;
  }
  for (const order of ["button first", "registry reader first"] as const) {
    test(`${order}: the button resolves its label and the reader gets the whole registry`, async () => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      let read: unknown;
      const ctx = makeRenderCtx({ interactive: true });
      const obj = { id: "o1", x: 0, y: 0, w: 0.3, h: 0.2, z: 1, config: { type: "action-button", actionId: "baptism.advance" }, style: {} } as never;
      const button = React.createElement(ObjectContent as never, { key: "button", o: obj, ctx });
      const reader = React.createElement(RegistryReader, { key: "reader", onRead: (d: unknown) => (read = d) });
      const { container } = render(
        React.createElement(
          QueryClientProvider as never,
          { client: qc },
          ...(order === "button first" ? [button, reader] : [reader, button]),
        ),
      );
      await waitFor(() => assert.ok(container.textContent?.includes("Advance the baptism timer"), container.textContent ?? ""));
      await waitFor(() =>
        assert.ok(
          Array.isArray((read as { actions?: unknown } | undefined)?.actions),
          `the registry reader got ${JSON.stringify(read)}, not the whole registry`,
        ),
      );
    });
  }
});
