// The screen tile's status dot means CONNECTED, and connected means a heartbeat.
//
// The dot used to be `outputs.filter(o => o.viewId)` — routed, not connected —
// so a screen that was routed and unplugged stayed lit for ever. On a producer
// wall that is the worst available lie: the one tile you need to notice is the
// one that looks fine. Every test here therefore holds the routing FIXED and
// varies only the heartbeat, or the reverse, so a dot that has quietly gone back
// to reading the routed set cannot pass.
//
// The dot is also the only thing on a tile readable from across a producer desk,
// which is why it gets its own file rather than a line in the embed suite.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom does no layout, and the tile sizes its child by MEASURING its body. */
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  get: () => 270,
  configurable: true,
});

// jsdom ships no EventSource, and a render opens the state stream.
class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

const ROUTED_VIEW: View = {
  id: "v-1",
  name: "Slots A",
  kind: "custom",
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    canvas: { width: 1920, height: 1080, fit: "contain" },
    objects: [
      { id: "t1", x: 0, y: 0, w: 1, h: 1, z: 0,
        config: { type: "text", text: "ROUTED VIEW BODY" }, style: { fontSize: 0.1 } },
    ],
  },
};

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act, useEffect } = await import("react");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { RenderObject } = await import("./layout-renderer.js");
const { makeRenderCtx, DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");
const { useDisplayPresence } = await import("./use-display-presence.js");

const STATE: StageState = { ...DEFAULT_STAGE_STATE, views: [ROUTED_VIEW], outputs: [] };

/** Every path a render touches, plus a settable presence answer. */
let presence: { connected: string[] } = { connected: [] };
let presenceReads: string[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const u = String(url);
  if (u.includes("/api/displays/presence")) presenceReads.push(u);
  const body = u.includes("/api/displays/presence")
    ? presence
    : u.includes("/api/state")
      ? STATE
      : u.includes("transcript")
        ? []
        : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => { cleanup(); presenceReads = []; });
afterEach(async () => { cleanup(); await settle(); });

async function draw(element: React.ReactElement) {
  let container!: HTMLElement;
  await act(async () => {
    container = render(React.createElement(TooltipProvider as never, null, element)).container;
    await settle();
  });
  return container;
}

const tile = {
  id: "o1", x: 0, y: 0, w: 1, h: 1, z: 1,
  config: { type: "screen-embed", outputId: "out-1", showLabel: true, showStatus: true },
  style: {},
};

/** The dot's label, through the real RenderObject — registry, switch and all. */
async function dotLabel(output: Output, onlineOutputIds: string[]): Promise<string> {
  const container = await draw(React.createElement(RenderObject, {
    o: tile,
    ctx: makeRenderCtx({ state: { ...STATE, outputs: [output] }, onlineOutputIds }),
  } as never));
  const dot = container.querySelector("[aria-label]");
  assert.ok(dot, "the tile drew no status dot");
  return dot.getAttribute("aria-label") ?? "";
}

const ROUTED: Output = { id: "out-1", name: "Left Display", viewId: "v-1" };

describe("the dot means connected, not merely routed", () => {
  test("a routed screen with NO heartbeat reads as not connected", async () => {
    // The exact bug: `outputs.filter(o => o.viewId)` calls this screen online for
    // ever. Routed, view exists, not blacked out — and nobody is watching it.
    assert.equal(await dotLabel(ROUTED, []), "Not connected");
  });

  test("a routed screen WITH a heartbeat reads as connected", async () => {
    // The same fixture, so the ONLY difference between this and the test above
    // is the heartbeat. A dot reading the routed set passes one and fails the
    // other; a dot reading presence passes both.
    assert.equal(await dotLabel(ROUTED, ["out-1"]), "Connected");
  });

  test("an UNROUTED screen that is connected still reports its heartbeat", async () => {
    // Routed and connected are independent facts and the tile must not conflate
    // them again. A browser IS open on this screen — it is showing the "not
    // showing anything" notice, which is a thing somebody can see.
    assert.equal(
      await dotLabel({ id: "out-1", name: "Left Display", viewId: null }, ["out-1"]),
      "Connected",
    );
  });

  test("a blacked-out screen that is connected still reports its heartbeat", async () => {
    // The other direction of the same independence: blackout is what the screen
    // is showing, and the body says so. It is not an absence of a browser.
    assert.equal(
      await dotLabel({ ...ROUTED, blackout: true }, ["out-1"]),
      "Connected",
    );
  });

  test("another screen's heartbeat does not light this one", async () => {
    // A set-membership test, not a "is anything online" test — the difference
    // between a wall of dots and a single lamp.
    assert.equal(await dotLabel(ROUTED, ["out-2", "out-3"]), "Not connected");
  });
});

/** Probe: renders whatever the hook returns, so the hook itself is on the path. */
function Probe({ enabled, onIds }: { enabled: boolean; onIds: (ids: readonly string[]) => void }) {
  const ids = useDisplayPresence(enabled);
  useEffect(() => { onIds(ids); }, [ids, onIds]);
  return React.createElement("span", null, ids.join(","));
}

describe("useDisplayPresence", () => {
  test("reads the connected set on mount, rather than waiting for a change", async () => {
    // Presence broadcasts ONLY when it changes, so a hook that only subscribed
    // would render every dot dark in a quiet building until somebody unplugged
    // something. This is the read that makes the first paint true.
    presence = { connected: ["out-1", "out-9"] };
    const container = await draw(React.createElement(Probe, { enabled: true, onIds: () => {} }));
    assert.equal(container.textContent, "out-1,out-9");
    assert.equal(presenceReads.length, 1, "the hook did not read presence on mount");
  });

  test("disabled, it subscribes to nothing and reports nothing", async () => {
    // The objection that kept the fake in place: an object on a wall display has
    // no business subscribing to presence. It does not have to — the gate is the
    // same one useObsState is behind.
    presence = { connected: ["out-1"] };
    const container = await draw(React.createElement(Probe, { enabled: false, onIds: () => {} }));
    assert.equal(container.textContent, "");
    assert.equal(presenceReads.length, 0, "a disabled hook still asked the server for presence");
  });

  test("a failed read reports nothing, never a stale everything", async () => {
    // "We do not know" has to read as NOT connected. The one direction a failure
    // must never fall is the reassuring one.
    presence = { connected: ["out-1"] };
    const realFetch = (globalThis as unknown as { fetch: unknown }).fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
      if (String(url).includes("/api/displays/presence")) throw new Error("offline");
      return (realFetch as (u: unknown) => Promise<unknown>)(url);
    };
    try {
      const container = await draw(React.createElement(Probe, { enabled: true, onIds: () => {} }));
      assert.equal(container.textContent, "");
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
    }
  });
});
