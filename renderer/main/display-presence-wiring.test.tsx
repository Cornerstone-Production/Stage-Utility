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

// jsdom ships no EventSource, and a render opens the state stream. This one
// DELIVERS: a stub whose addEventListener was a no-op let a hook that subscribed
// and never updated pass a full suite green — which is the exact behaviour this
// file exists for, since the dot going dark when a tab closes arrives only ever
// as a pushed frame.
type Frame = (e: { data: string }) => void;
const streams: StubEventSource[] = [];
class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  onopen: unknown = null;
  listeners = new Map<string, Set<Frame>>();
  constructor() {
    streams.push(this);
  }
  addEventListener(channel: string, cb: Frame): void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(cb);
  }
  removeEventListener(channel: string, cb: Frame): void {
    this.listeners.get(channel)?.delete(cb);
  }
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

/** Push a `displays:presence` frame down every open stream, as the server does. */
function pushPresence(connected: string[], rev: number): void {
  const data = JSON.stringify({ connected, rev });
  for (const s of streams) for (const cb of [...(s.listeners.get("displays:presence") ?? [])]) cb({ data });
}

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
let presence: { connected: string[]; rev: number } = { connected: [], rev: 0 };
let presenceReads: string[] = [];
/** When set, the presence read hangs until this resolves — so a test can land a
 *  pushed frame while the read is genuinely in flight. */
let holdPresence: Promise<void> | null = null;
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const u = String(url);
  const isPresence = u.includes("/api/displays/presence");
  if (isPresence) presenceReads.push(u);
  const body = isPresence
    ? presence
    : u.includes("/api/state")
      ? STATE
      : u.includes("transcript")
        ? []
        : {};
  return {
    ok: true,
    status: 200,
    // apiFetch returns res.json(), so a pending json() defers the whole read.
    json: async () => {
      if (isPresence && holdPresence) await holdPresence;
      return isPresence ? presence : body;
    },
    text: async () => JSON.stringify(body),
  };
};

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => { cleanup(); presenceReads = []; holdPresence = null; });
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
    presence = { connected: ["out-1", "out-9"], rev: 3 };
    const container = await draw(React.createElement(Probe, { enabled: true, onIds: () => {} }));
    assert.equal(container.textContent, "out-1,out-9");
    assert.equal(presenceReads.length, 1, "the hook did not read presence on mount");
  });

  test("disabled, it subscribes to nothing and reports nothing", async () => {
    // The objection that kept the fake in place: an object on a wall display has
    // no business subscribing to presence. It does not have to — the gate is the
    // same one useObsState is behind.
    presence = { connected: ["out-1"], rev: 3 };
    const container = await draw(React.createElement(Probe, { enabled: false, onIds: () => {} }));
    assert.equal(container.textContent, "");
    assert.equal(presenceReads.length, 0, "a disabled hook still asked the server for presence");
  });

  test("a failed read reports nothing, never a stale everything", async () => {
    // "We do not know" has to read as NOT connected. The one direction a failure
    // must never fall is the reassuring one.
    presence = { connected: ["out-1"], rev: 3 };
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

describe("useDisplayPresence stays live after the first read", () => {
  // The half that ships broken and green: a hook that subscribes and never
  // applies what it is handed. Replacing the notification body with a no-op left
  // every other test in this file passing, because they only exercise the mount
  // read — and the behaviour the whole task exists for, a dot going dark when a
  // tab closes, arrives ONLY as a pushed frame.

  test("a screen that appears in a pushed set lights up", async () => {
    // Revisions only ever go up across this file: api.ts caches the last payload
    // per channel for the life of the module, so a later test reading a LOWER
    // revision than an earlier test pushed is a server that cannot exist.
    presence = { connected: [], rev: 5 };
    const container = await draw(React.createElement(Probe, { enabled: true, onIds: () => {} }));
    assert.equal(container.textContent, "", "the mount read should have reported nothing");
    await act(async () => { pushPresence(["out-1"], 6); await settle(); });
    assert.equal(container.textContent, "out-1", "a pushed connection never reached the hook");
  });

  test("a screen that DISAPPEARS from a pushed set goes dark — the closed tab", async () => {
    // This is the transition the routed-set fake could never produce: nothing
    // about the screen's configuration changed, only whether a browser is on it.
    presence = { connected: ["out-1", "out-2"], rev: 10 };
    const container = await draw(React.createElement(Probe, { enabled: true, onIds: () => {} }));
    assert.equal(container.textContent, "out-1,out-2");
    await act(async () => { pushPresence(["out-1"], 11); await settle(); });
    assert.equal(container.textContent, "out-1", "the closed screen stayed lit");
    await act(async () => { pushPresence([], 12); await settle(); });
    assert.equal(container.textContent, "", "the last screen closing left the hook lit");
  });

  test("a push that lands mid-read is not clobbered by the older read", async () => {
    // Both deliver the same server-side truth, and arrival order does not say
    // which is newer. Ordered by revision: the read was computed at rev 20, the
    // broadcast is rev 21, so the broadcast stands. Last-write-wins would put the
    // closed screen back and leave it there until the next change.
    let release!: () => void;
    holdPresence = new Promise<void>((r) => { release = r; });
    presence = { connected: ["out-1", "out-2"], rev: 20 };
    const container = await draw(React.createElement(Probe, { enabled: true, onIds: () => {} }));
    await act(async () => { pushPresence(["out-1"], 21); await settle(); });
    assert.equal(container.textContent, "out-1");
    await act(async () => { release(); await settle(); });
    assert.equal(container.textContent, "out-1", "the in-flight read overwrote a newer broadcast");
  });

  test("a failing read on re-enable clears what was there, rather than leaving it lit", async () => {
    // First mount reads a live screen, then the hook is disabled and re-enabled
    // with the read failing. Without the clear, `out-1` survives in state and
    // renders as Connected on the strength of a read that just failed.
    presence = { connected: ["out-1"], rev: 30 };
    let result!: { rerender: (el: React.ReactElement) => void; container: HTMLElement };
    const probe = (enabled: boolean) =>
      React.createElement(TooltipProvider as never, null, React.createElement(Probe, { enabled, onIds: () => {} }));
    await act(async () => { result = render(probe(true)) as never; await settle(); });
    assert.equal(result.container.textContent, "out-1");

    await act(async () => { result.rerender(probe(false)); await settle(); });

    const realFetch = (globalThis as unknown as { fetch: unknown }).fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
      if (String(url).includes("/api/displays/presence")) throw new Error("offline");
      return (realFetch as (u: unknown) => Promise<unknown>)(url);
    };
    try {
      await act(async () => { result.rerender(probe(true)); await settle(); });
      assert.equal(result.container.textContent, "", "a failed re-read left the old set lit");
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
    }
  });
});
