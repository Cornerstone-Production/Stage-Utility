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
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
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

// The Needs setup badge — Button.dc.html's board. `editing` is the layout
// editor's own flag (LayoutRenderCtx, set only by layout-editor.tsx's
// fullCtx); this file drives it directly rather than through the editor, the
// way every other case above drives `interactive` directly.
describe("action-button — the Needs setup badge (editor only)", () => {
  const WITH_PARAMS = [
    {
      id: "rosstalk.command",
      label: "Send a RossTalk command",
      params: [{ key: "targetId", label: "Target", type: "enum", optionsFrom: "rosstalk-targets" }],
    },
  ];

  function renderWithCtx(
    config: { type: "action-button"; actionId: string; params?: Record<string, unknown> },
    ctxOverrides: { interactive?: boolean; editing?: boolean },
  ) {
    const obj = { id: "o1", x: 0, y: 0, w: 0.3, h: 0.2, z: 1, config, style: {} } as never;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const ctx = makeRenderCtx(ctxOverrides);
    return render(
      React.createElement(
        QueryClientProvider as never,
        { client: qc },
        React.createElement(ObjectContent as never, { o: obj, ctx }),
      ),
    );
  }

  test("editing + a required param unset: shows the badge", async () => {
    registryActions = WITH_PARAMS;
    const { container } = renderWithCtx(
      { type: "action-button", actionId: "rosstalk.command", params: {} },
      { interactive: false, editing: true },
    );
    await waitFor(() => assert.ok(container.querySelector('[data-needs-setup="true"]')));
  });

  test("editing + every required param set: no badge", async () => {
    registryActions = WITH_PARAMS;
    const { container } = renderWithCtx(
      { type: "action-button", actionId: "rosstalk.command", params: { targetId: "t1" } },
      { interactive: false, editing: true },
    );
    await waitFor(() => assert.ok(container.textContent?.includes("Send a RossTalk command")));
    // A COUNT, never the element itself: node:assert inspects `actual` to build
    // a failure message, and inspecting a live jsdom element does not
    // terminate in any useful time — see the header comment on
    // rule-editor-dialog.test.tsx. `assert.equal(el, null)` looks safe and
    // hangs the runner for ~30s the moment the assertion is false, which
    // reads as a stuck render loop rather than the one failing line it is.
    assert.equal(container.querySelectorAll('[data-needs-setup="true"]').length, 0);
  });

  test("NOT editing (a live display or console): never shows the badge, issues or not", async () => {
    registryActions = WITH_PARAMS;
    const { container } = renderWithCtx(
      { type: "action-button", actionId: "rosstalk.command", params: {} },
      { interactive: true, editing: false },
    );
    await waitFor(() => assert.ok(container.textContent?.includes("Send a RossTalk command")));
    // A count, not the element — see the comment above.
    assert.equal(
      container.querySelectorAll('[data-needs-setup="true"]').length,
      0,
      "a live display must never show the editor-only marker",
    );
  });

  // companion.press's real shape, truly unpicked (params: {} — never seeded,
  // see hasCustomParamsPicker in rule-editor-dialog.tsx). The bug this guards:
  // seedNumberDefaults used to run for every action including this one, so a
  // freshly-picked companion.press button never actually reached this state —
  // it landed on {page: 1, row: 0, col: 0} instead, which validateParams (and
  // this badge) reads as complete. This proves the OTHER half: once nothing
  // is seeded, an unpicked button still reports its three missing params and
  // still shows the badge, the same as any other action with unset params.
  test("companion.press with no button chosen: shows the badge, same as any other unset action", async () => {
    registryActions = [
      {
        id: "companion.press",
        label: "Press a Companion button",
        params: [
          { key: "page", label: "Page", type: "number", min: 1, max: 999 },
          { key: "row", label: "Row", type: "number", min: 0, max: 99 },
          { key: "col", label: "Column", type: "number", min: 0, max: 99 },
        ],
      },
    ] as never;
    const { container } = renderWithCtx(
      { type: "action-button", actionId: "companion.press", params: {} },
      { interactive: false, editing: true },
    );
    await waitFor(() => assert.ok(container.querySelector('[data-needs-setup="true"]')));
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
