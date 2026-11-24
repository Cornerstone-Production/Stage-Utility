// The Q-SYS objects, rendered through the layout renderer against a stubbed server.
//
// What these pin is behaviour: when a write goes out, and when it must not; what
// an object says; what it ignores. Every "never sends" case carries a positive
// control (the hydration read that DID happen), so a store that read nothing
// cannot pass by sending nothing.
//
// NOT unit-tested here, and checked in a browser instead: how the objects LOOK.
// jsdom loads no stylesheet and lays nothing out, so every CSS variable is "" and
// every box is 0x0. The fader's track length is stubbed below so a drag has a
// scale; the thumb's place, the meter's colour bands and the limit line are
// verified by driving a real page. States are asserted through `data-state`,
// `aria-pressed` and the words on the controls, which are what those looks are
// chosen from.
//
// The objects and their store run through the React Compiler here, as the built
// app runs them (react-compiler-hook.ts). Uncompiled, a component reading the
// store outside its hook's snapshot passes every case below and freezes in the
// browser: a built panel once drew every control offline for good.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { compileWithReactCompiler } from "../../test-fixtures/react-compiler-hook.js";
import { installDom, unmountAndTeardown } from "../../test-dom.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const compiled = compileWithReactCompiler((url) => /\/renderer\/main\/qsys\/[^/]+\.tsx?$/.test(url) && !/\.test\.tsx?$/.test(url));
const teardown = installDom();
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("../layout-renderer.js");
const { makeRenderCtx } = await import("../test-render-ctx.js");
const { __resetReplayCacheForTests, __sseFallback, __setSubscribedDeadlineForTests } = await import("../../lib/api.js");
const { __resetQsysPanelsForTests, DRAG_COALESCE_MS, QsysPanel } = await import("./use-qsys-values.js");
const { FLASH_MS, HOLD_MS } = await import("./qsys-objects.js");
type LayoutObjectConfig = import("@main/types/views").LayoutObjectConfig;

after(() => unmountAndTeardown(cleanup, teardown));

// jsdom has no layout: give every element a 200 px box so a drag has a scale.
(window.HTMLElement.prototype as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 200, width: 200, height: 200,
});

const MIX = "Lobby_Mixer";
const b = (control: string) => ({ component: MIX, control });

const CATALOG = {
  designCode: "d1",
  components: [
    {
      name: MIX,
      type: "mixer",
      controls: [
        { Name: "gain", Type: "Float", ValueMin: -100, ValueMax: 20 },
        { Name: "mute", Type: "Boolean" },
        { Name: "meter", Type: "Float", ValueMin: -100, ValueMax: 20 },
        { Name: "load_1", Type: "Trigger" },
        { Name: "save", Type: "Trigger" },
        { Name: "zone_name", Type: "Text" },
        // On the Core, not on the allowlist.
        { Name: "gain_free", Type: "Float", ValueMin: -100, ValueMax: 20 },
        { Name: "mute_free", Type: "Boolean" },
        { Name: "load_free", Type: "Trigger" },
        // A momentary (Boolean on a button), and a level the Core says is read-only.
        { Name: "talk", Type: "Boolean" },
        { Name: "level_ro", Type: "Float", Direction: "Read", ValueMin: -100, ValueMax: 20 },
      ],
    },
  ],
};

const ALLOW = {
  entries: [
    { component: MIX, control: "gain", label: "", min: -100, max: 0, confirm: "none" },
    { component: MIX, control: "mute", label: "", min: null, max: null, confirm: "none" },
    { component: MIX, control: "load_1", label: "", min: null, max: null, confirm: "none" },
    { component: MIX, control: "save", label: "", min: null, max: null, confirm: "none" },
    { component: MIX, control: "talk", label: "", min: null, max: null, confirm: "none" },
    { component: MIX, control: "level_ro", label: "", min: -100, max: 20, confirm: "none" },
  ],
};

interface Server {
  ready: boolean;
  /** How many catalog reads fail before one answers. */
  catalogFails: number;
  /** When set, a write's answer waits for this to be called. */
  holdWrites: ((release: () => void) => void) | null;
  coreState: "connected" | "reconnecting" | "offline";
  /** When set, a subscribe report's answer waits for this to be called. */
  holdSubscribes: ((release: () => void) => void) | null;
  /** When set, a values read's answer waits for this to be called. */
  holdReads: ((release: () => void) => void) | null;
  allowFails: boolean;
  catalog: typeof CATALOG;
  values: Record<string, unknown>;
  /** What a write answers; the default lands it as sent. */
  answer: (body: Record<string, unknown>) => unknown;
  writes: { body: Record<string, unknown>; at: number }[];
  reads: number;
  subscribes: string[][];
  renewals: number;
  /** What a renewal answers. */
  leaseHeld: boolean;
  renewCids: unknown[];
  /** How many renewals fail (a 500) before one answers. */
  renewFails: number;
  /** When set, a renewal's answer waits for this to be called, and says what `leaseHeld` is then. */
  holdRenewals: ((release: () => void) => void) | null;
}

let server: Server;

function freshServer(): Server {
  return {
    ready: true,
    catalogFails: 0,
    holdWrites: null,
    coreState: "connected",
    holdSubscribes: null,
    holdReads: null,
    allowFails: false,
    catalog: CATALOG,
    values: { gain: -20, mute: false, meter: -30, load_1: 0, save: 0, zone_name: "Zone 1", gain_free: -10, mute_free: false, load_free: 0, talk: false, level_ro: -5 },
    answer: (body) => ({ ok: true, value: body.value, string: String(body.value), clamped: false }),
    writes: [],
    reads: 0,
    subscribes: [],
    renewals: 0,
    leaseHeld: true,
    renewCids: [],
    renewFails: 0,
    holdRenewals: null,
  };
}

// One fetch stub for the file, answering from whichever `server` the current test
// set up: a debounced subscribe report can fire after a test has ended, and must
// still find a stub rather than the real fetch.
const f = stubFetchWithLog((url, init) => {
  if (url.includes("/api/events/subscribe")) {
    server.subscribes.push((JSON.parse(String(init?.body ?? "{}")) as { channels: string[] }).channels);
    const hold = server.holdSubscribes;
    if (hold) return new Promise((resolve) => hold(() => resolve(ok({}))));
    return ok({});
  }
  if (url.startsWith("/api/qsys/values")) {
    server.reads++;
    // Answered with the values as they are when it is ANSWERED, as the server's would be.
    const answer = () =>
      ok({
        ready: server.ready,
        values: Object.entries(server.values).map(([control, value]) => ({ component: MIX, control, value, string: String(value) })),
      });
    const hold = server.holdReads;
    if (hold) return new Promise((resolve) => hold(() => resolve(answer())));
    return answer();
  }
  if (url === "/api/qsys/lease") {
    server.renewals++;
    server.renewCids.push((JSON.parse(String(init?.body ?? "{}")) as { cid?: unknown }).cid);
    if (server.renewFails > 0) {
      server.renewFails--;
      return { ok: false, status: 500, statusText: "Error", json: async () => ({ error: "busy" }), text: async () => "" };
    }
    const hold = server.holdRenewals;
    if (hold) return new Promise((resolve) => hold(() => resolve(ok({ held: server.leaseHeld }))));
    return ok({ held: server.leaseHeld });
  }
  if (url === "/api/qsys/status") return ok({ connected: server.coreState === "connected", state: server.coreState });
  if (url === "/api/qsys/allowlist") {
    if (server.allowFails) return { ok: false, status: 500, statusText: "Error", json: async () => ({ error: "disk" }), text: async () => "" };
    return ok(ALLOW);
  }
  if (url === "/api/qsys/catalog") {
    if (server.catalogFails > 0) {
      server.catalogFails--;
      return { ok: false, status: 503, statusText: "Error", json: async () => ({ error: "not connected" }), text: async () => "" };
    }
    return ok(server.catalog);
  }
  if (url === "/api/qsys/write") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    server.writes.push({ body, at: Date.now() });
    const answer = ok(server.answer(body));
    const hold = server.holdWrites;
    if (hold) return new Promise((resolve) => hold(() => resolve(answer)));
    return answer;
  }
  throw new Error(`unexpected request ${url}`);
});
after(async () => {
  // Let the last debounced subscribe report (200 ms) land on the stub first.
  await new Promise((r) => setTimeout(r, 300));
  f.restore();
});

beforeEach(() => {
  server = freshServer();
  __resetReplayCacheForTests();
  __resetQsysPanelsForTests();
  __sseFallback.noteStream(true);
});

afterEach(() => {
  cleanup();
});

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

let nextId = 0;
function obj(config: LayoutObjectConfig) {
  return { id: `o${nextId++}`, x: 0, y: 0, w: 0.2, h: 0.5, z: 1, config, style: {} } as never;
}

async function mount(configs: LayoutObjectConfig[], { interactive = true, view = "v1" } = {}) {
  const ctx = makeRenderCtx({ interactive, embedChain: [view] });
  const r = render(React.createElement(React.Fragment, null, ...configs.map((c) => React.createElement(ObjectContent as never, { o: obj(c), ctx, key: String(nextId) }))));
  await wait(30);
  return r;
}

const FADER: LayoutObjectConfig = { type: "qsys-fader", binding: b("gain"), orientation: "vertical", showDb: true, steps: false, stepDb: 3 };

const q = (type: string, sel = "") => document.querySelector(`[data-qsys-object="${type}"] ${sel}`.trim()) as HTMLElement;
const dbText = () => q("qsys-fader", "[data-db]").textContent;

function down(el: Element, clientY: number) {
  act(() => {
    fireEvent.pointerDown(el, { pointerId: 1, clientY, clientX: 0, pointerType: "touch", button: 0 });
  });
}
function move(clientY: number) {
  act(() => {
    window.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 1, clientY, clientX: 0 }));
  });
}
function up(clientY: number) {
  act(() => {
    window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1, clientY, clientX: 0 }));
  });
}
function stream(upNow: boolean) {
  act(() => __sseFallback.noteStream(upNow));
}
function push(channel: string, changes: { control: string; value: unknown }[]) {
  act(() => FakeEventSource.last!.push(channel, { changes: changes.map((c) => ({ Component: MIX, Name: c.control, Value: c.value, String: String(c.value) })) }));
}

/** Every Q-SYS object type, sorted, one per line, each bound to a control the fixture has. */
const EVERY: LayoutObjectConfig[] = [
  { type: "qsys-button", binding: b("save"), label: "Save", hold: false },
  FADER,
  { type: "qsys-label", binding: b("zone_name"), text: "" },
  { type: "qsys-meter", binding: b("meter"), form: "bar" },
  { type: "qsys-mute", binding: b("mute") },
  { type: "qsys-presets", items: [{ label: "One", binding: b("load_1") }] },
  { type: "qsys-selector", items: [{ label: "A", binding: b("load_1") }] },
  { type: "qsys-status" },
  { type: "qsys-strip", name: null, label: "Lead", gain: b("gain"), mute: b("mute"), meter: b("meter") },
  { type: "qsys-switch", binding: b("mute"), label: "Thing" },
];

describe("Q-SYS objects", () => {
  test("the objects and their store run through the React Compiler here", () => {
    assert.ok(compiled() >= 3, `the compiler ran over ${compiled()} module(s); expected the objects, the store and the tween`);
  });

  test("every Q-SYS object type is covered here", async () => {
    const { LAYOUT_OBJECT_TYPES } = await import("@main/types/layout-object-types");
    assert.deepEqual(
      EVERY.map((c) => c.type),
      LAYOUT_OBJECT_TYPES.filter((t) => t.startsWith("qsys-")).sort(),
    );
  });

  test("the panel names qsys:watch:<viewId> while mounted, and drops it after", async () => {
    const r = await mount([FADER]);
    await wait(250);
    assert.ok(server.subscribes.at(-1)?.includes("qsys:watch:v1"), `the last subscribe report: ${JSON.stringify(server.subscribes.at(-1))}`);
    r.unmount();
    await wait(250);
    assert.ok(!server.subscribes.at(-1)?.includes("qsys:watch:v1"), "still watching after unmount");
  });

  test("fader drag is relative: pointer down at any height does not change the value", async () => {
    await mount([FADER]);
    assert.equal(dbText(), "-20.0");
    const fader = q("qsys-fader", "[data-fader]");
    down(fader, 5); // near the top of the track, far above the thumb
    assert.equal(dbText(), "-20.0", "touching moved the value");
    move(5); // no movement
    up(5);
    await wait(30);
    assert.equal(server.writes.length, 0, "a tap sent its own value back");

    down(fader, 190);
    move(170); // 20 px up of 200 over the fader's -60..0 dB: +6 dB from where it was
    assert.equal(dbText(), "-14.0");
    up(170);
    await wait(30);
    assert.deepEqual(server.writes.at(-1)!.body.value, -14);
  });

  test("fader drag sends at most one write per 40 ms and always sends the release value", async () => {
    await mount([FADER]);
    const fader = q("qsys-fader", "[data-fader]");
    const began = Date.now();
    down(fader, 100);
    for (let i = 1; i <= 40; i++) {
      move(100 - i / 2);
      await wait(3);
    }
    const lasted = Date.now() - began;
    up(80);
    await wait(150);
    const sent = server.writes.map((w) => w.body);
    // Forty moves: one write per move would be forty.
    assert.ok(sent.length >= 2, `a drag of ${lasted} ms sent ${sent.length} writes`);
    assert.ok(sent.length <= Math.floor(lasted / DRAG_COALESCE_MS) + 2, `a drag of ${lasted} ms sent ${sent.length} writes; at most one per 40 ms plus the release`);
    const intermediate = server.writes.filter((w) => w.body.final === false);
    for (let i = 1; i < intermediate.length; i++) {
      const gap = intermediate[i].at - intermediate[i - 1].at;
      assert.ok(gap >= DRAG_COALESCE_MS - 2, `two drag writes ${gap} ms apart`);
    }
    const last = sent.at(-1)!;
    assert.equal(last.final, true, "the release is marked final");
    assert.equal(last.value, -14, "the release carries where the finger stopped (20 px = +6 dB)");
    assert.equal(sent.filter((w) => w.final === true).length, 1);
    assert.equal(sent.at(-1)!.panelId, "v1");
  });

  test("a refused write snaps the fader back to the Core value", async () => {
    server.answer = () => ({ ok: false, reason: "not-allowed", message: "Lobby_Mixer/gain is not on the allowlist" });
    await mount([FADER]);
    const fader = q("qsys-fader", "[data-fader]");
    down(fader, 100);
    move(80);
    assert.equal(dbText(), "-14.0", "moved under the finger at once");
    await wait(30);
    assert.equal(dbText(), "-20.0", "back to the Core's value after the refusal");
    const before = server.writes.length;
    move(60);
    up(60);
    await wait(60);
    assert.equal(server.writes.length, before, "the refusal ended the drag");
  });

  test("offline state greys every Q-SYS object and ignores input", async () => {
    await mount(EVERY);
    for (const c of EVERY) {
      if (c.type === "qsys-status") continue;
      assert.equal(q(c.type).dataset.state, "live", `${c.type} is live before the drop (positive control)`);
    }
    stream(false);
    for (const c of EVERY) {
      const el = q(c.type);
      assert.equal(el.dataset.state, "offline", `${c.type} is not offline`);
      // The status object reports the outage rather than greying itself out.
      if (c.type !== "qsys-status") assert.equal((el.querySelector("[data-qsys-body]") as HTMLElement).style.opacity, "0.35", `${c.type} is not greyed`);
    }
    for (const el of document.querySelectorAll("button")) {
      act(() => {
        fireEvent.pointerDown(el, { pointerId: 2 });
        fireEvent.click(el);
      });
    }
    down(q("qsys-fader", "[data-fader]"), 100);
    move(50);
    up(50);
    await wait(HOLD_MS + 100);
    assert.equal(server.writes.length, 0, "an offline object wrote");
    assert.equal(q("qsys-status", "[data-connection]").dataset.connection, "reconnecting");
  });

  test("mute shows the word Muted, not only a colour", async () => {
    await mount([{ type: "qsys-mute", binding: b("mute") }]);
    const btn = q("qsys-mute", "button");
    assert.equal(btn.textContent, "Mute");
    assert.equal(btn.getAttribute("aria-pressed"), "false");
    act(() => {
      fireEvent.click(btn);
    });
    await wait(30);
    assert.deepEqual(server.writes.map((w) => w.body.value), [true], "a tap writes the Core's state flipped");
    assert.equal(btn.textContent, "Muted", "the Core's read-back says muted");
    push("qsys:values", [{ control: "mute", value: false }]);
    assert.equal(btn.textContent, "Mute", "a UCI unmuting it is shown");
  });

  test("a preset with no readable state renders unlit and flashes on a confirmed write", async () => {
    await mount([{ type: "qsys-presets", items: [{ label: "One", binding: b("load_1") }] }]);
    const btn = q("qsys-presets", "button");
    assert.equal(btn.getAttribute("aria-pressed"), "false");
    act(() => {
      fireEvent.click(btn);
    });
    await wait(30);
    assert.deepEqual(server.writes.map((w) => w.body.value), [true]);
    assert.equal(btn.getAttribute("aria-pressed"), "true", "flashes once the Core confirms");
    await wait(FLASH_MS + 50);
    assert.equal(btn.getAttribute("aria-pressed"), "false", "and goes back to unlit: never lit from the page's own write");

    server.answer = () => ({ ok: false, reason: "core-error", message: "no" });
    act(() => {
      fireEvent.click(btn);
    });
    await wait(30);
    assert.equal(btn.getAttribute("aria-pressed"), "false", "a refused trigger does not flash");
  });

  test("a preset lights from its indicator, and only from it", async () => {
    server.values.match_1 = 0;
    await mount([{ type: "qsys-presets", items: [{ label: "One", binding: { ...b("load_1"), indicator: b("match_1") } }] }]);
    const btn = q("qsys-presets", "button");
    assert.equal(btn.getAttribute("aria-pressed"), "false");
    push("qsys:values", [{ control: "match_1", value: 1 }]);
    assert.equal(btn.getAttribute("aria-pressed"), "true");
  });

  test("hold-to-confirm only writes after the full hold", async () => {
    await mount([{ type: "qsys-button", binding: b("save"), label: "Save", hold: true }]);
    const btn = q("qsys-button", "button");
    act(() => {
      fireEvent.pointerDown(btn, { pointerId: 3 });
    });
    assert.equal(btn.textContent, "Keep holding to save…", "the kit's words");
    await wait(HOLD_MS / 2);
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 3 }));
      fireEvent.click(btn);
    });
    await wait(HOLD_MS);
    assert.equal(server.writes.length, 0, "let go halfway, and it wrote");
    assert.equal(btn.textContent, "Save");

    act(() => {
      fireEvent.pointerDown(btn, { pointerId: 4 });
    });
    await wait(HOLD_MS + 60);
    assert.deepEqual(server.writes.map((w) => w.body.value), [true], "the full hold writes once");

    act(() => {
      fireEvent.pointerDown(btn, { pointerId: 5 });
    });
    stream(false); // the connection drops mid-hold
    stream(true);
    await wait(HOLD_MS + 60);
    assert.equal(server.writes.length, 1, "a hold broken by a drop completed into a write");
  });

  test("a coalesced write still pending when the stream drops is discarded, not sent on reconnect", async () => {
    await mount([FADER]);
    const fader = q("qsys-fader", "[data-fader]");
    down(fader, 100);
    move(90); // sent at once
    move(80); // held for the 40 ms window
    await act(async () => {}); // the first write's request, not the 40 ms window
    assert.equal(server.writes.length, 1);
    const readsBefore = server.reads;
    stream(false);
    await wait(DRAG_COALESCE_MS + 30);
    stream(true);
    await wait(60);
    assert.ok(server.reads > readsBefore, "the reconnect read the panel again (positive control)");
    assert.equal(server.writes.length, 1, "the held drag value was sent after the drop");
    up(80);
    await wait(30);
    assert.equal(server.writes.length, 1, "the drag ended by the drop sent a release");
  });

  test("a drop and reconnect inside the coalesce window still discards the held value", async () => {
    await mount([FADER]);
    down(q("qsys-fader", "[data-fader]"), 100);
    move(90); // sent at once
    move(80); // held for the 40 ms window
    stream(false);
    stream(true); // back, and read again, before the window ends
    await wait(DRAG_COALESCE_MS * 2);
    assert.ok(q("qsys-fader").dataset.state === "live", "live again (positive control)");
    assert.equal(server.writes.length, 1, "the held value went out once the panel was live again");
  });

  test("hydrating or reconnecting never sends a write; only a new pointer gesture does", async () => {
    await mount(EVERY);
    const reads0 = server.reads;
    assert.ok(reads0 >= 1, "the panel was read on mount (positive control)");
    // A UCI moves them; the server's cache follows, as the watch's does.
    server.values.gain = -6;
    server.values.mute = true;
    push("qsys:values", [{ control: "gain", value: -6 }, { control: "mute", value: true }]);
    push("qsys:meters:staff", [{ control: "meter", value: -12 }]);
    stream(false);
    stream(true);
    await wait(40);
    act(() => FakeEventSource.last!.push("qsys:status", { connected: false, state: "reconnecting" }));
    act(() => FakeEventSource.last!.push("qsys:status", { connected: true, state: "connected" }));
    await wait(40);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    await wait(40);
    assert.ok(server.reads >= reads0 + 3, `the reconnect, the Core's return and the wake each read the panel (${server.reads - reads0} reads)`);
    assert.equal(server.writes.length, 0, "a page sent its own state");

    act(() => {
      fireEvent.click(q("qsys-mute", "button"));
    });
    await wait(30);
    assert.deepEqual(server.writes.map((w) => w.body.value), [false], "a tap writes, once");
  });

  test("a drag in progress when the connection drops ends; the fader shows the Core value after rehydrate", async () => {
    await mount([FADER]);
    const fader = q("qsys-fader", "[data-fader]");
    down(fader, 100);
    move(80);
    await wait(10);
    assert.equal(dbText(), "-14.0");
    const sent = server.writes.length;
    server.values.gain = -11; // somebody else moved it meanwhile
    stream(false);
    assert.equal(dbText(), "-20.0", "the drag ended and shows the last Core value");
    stream(true);
    await wait(40);
    assert.equal(dbText(), "-11.0", "the Core's value once read again");
    move(40);
    up(40);
    await wait(40);
    assert.equal(server.writes.length, sent, "the ended drag wrote again");
    assert.equal(dbText(), "-11.0");
  });

  test("a fader stops at the allowlist's limit and says so", async () => {
    await mount([FADER]);
    const fader = q("qsys-fader", "[data-fader]");
    down(fader, 190);
    move(10); // far past 0 dB
    assert.equal(dbText(), "0.0");
    assert.ok(fader.hasAttribute("data-at-limit"));
    up(10);
    await wait(30);
    assert.equal(server.writes.at(-1)!.body.value, 0);
  });

  test("in the editor (not interactive) nothing writes", async () => {
    await mount([FADER, { type: "qsys-mute", binding: b("mute") }], { interactive: false });
    down(q("qsys-fader", "[data-fader]"), 100);
    move(50);
    up(50);
    act(() => {
      fireEvent.click(q("qsys-mute", "button"));
    });
    await wait(30);
    assert.equal(server.writes.length, 0);
    assert.equal(dbText(), "-20.0", "still shows the live value");
  });

  // A meter's height is where its level sits on a dB scale: a standalone meter's is
  // a fixed -60..+12 window, a strip's meter uses its fader's (floor max(-60 dB, the
  // allowlist's minimum), top the allowlist's maximum), so the two line up as in the
  // approved mockup. The Core's own -100..+20 range is NOT the scale: spent linearly,
  // it gave the bottom 40 dB of the bar to levels nobody listens to.
  test("a standalone meter draws on a -60..+12 dB window", async () => {
    await mount([{ type: "qsys-meter", binding: b("meter"), form: "bar" }]);
    const bar = q("qsys-meter", "[data-meter] > div");
    assert.ok(Math.abs(parseFloat(bar.style.height) - 41.667) < 0.01, `hydrated at -30 dB drew ${bar.style.height}`);
    push("qsys:meters:staff", [{ control: "meter", value: 6 }]);
    await wait(150);
    assert.ok(Math.abs(parseFloat(bar.style.height) - 91.667) < 0.01, `+6 dB drew ${bar.style.height}`);
    push("qsys:meters:staff", [{ control: "meter", value: 20 }]);
    await wait(250);
    assert.ok(parseFloat(bar.style.height) > 99.9, `above the top is the top, drew ${bar.style.height}`);
    push("qsys:meters:staff", [{ control: "meter", value: -80 }]);
    await wait(250);
    assert.ok(parseFloat(bar.style.height) < 0.5, `below the floor is empty, drew ${bar.style.height}`);
  });

  test("a strip's meter uses its fader's scale", async () => {
    // gain is allowlisted -100..0 on a -100..+20 control: the fader's travel is -60..0.
    await mount([{ type: "qsys-strip", name: null, label: "Lead", gain: b("gain"), mute: null, meter: b("meter") }]);
    const bar = q("qsys-strip", "[data-meter] > div");
    assert.ok(Math.abs(parseFloat(bar.style.height) - 50) < 0.01, `-30 dB on a -60..0 fader drew ${bar.style.height}`);
    push("qsys:meters:staff", [{ control: "meter", value: -80 }]);
    await wait(250);
    assert.ok(parseFloat(bar.style.height) < 0.5, `below the fader's floor is -inf, drew ${bar.style.height}`);
    push("qsys:meters:staff", [{ control: "meter", value: 6 }]);
    await wait(250);
    assert.ok(parseFloat(bar.style.height) > 99, `above the fader's top is the top, drew ${bar.style.height}`);
  });

  test("a meters-only strip has no fader to follow and uses the standalone window", async () => {
    await mount([{ type: "qsys-strip", name: null, label: "Room", gain: null, mute: null, meter: b("meter") }]);
    const bar = q("qsys-strip", "[data-meter] > div");
    assert.ok(Math.abs(parseFloat(bar.style.height) - 41.667) < 0.01, `drew ${bar.style.height}`);
  });
});

describe("the panel store", () => {
  test("a drag value held when the stream drops is not sent once the panel is live again", async () => {
    const panel = new QsysPanel("v1", "staff");
    panel.acquire();
    try {
      await wait(30);
      await panel.write(b("gain"), -15, { final: false }); // sent, and answered
      const held = panel.write(b("gain"), -12, { final: false, coalesceMs: 200 }); // waits out its window
      stream(false);
      stream(true);
      await wait(60);
      assert.equal(panel.stateSnapshot().live, true, "live again well inside the window (positive control)");
      await wait(250);
      assert.equal((await held).ok, false);
      assert.deepEqual(server.writes.map((w) => w.body.value), [-15], "the held value went out after the drop");
    } finally {
      panel.release();
    }
  });

  test("refuses a write, unsent, while the panel is offline; sends one once it is read again", async () => {
    const panel = new QsysPanel("v1", "staff");
    panel.acquire();
    try {
      await wait(30);
      stream(false);
      const refused = await panel.write(b("gain"), -10, { final: true });
      assert.equal(refused.ok, false);
      assert.equal(server.writes.length, 0, "an offline panel sent a write");
      stream(true);
      await wait(30);
      const landed = await panel.write(b("gain"), -10, { final: true });
      assert.equal(landed.ok, true, "the same write once live (positive control)");
      assert.equal(server.writes.length, 1);
    } finally {
      panel.release();
    }
  });
});

describe("the connection status object", () => {
  test("says Reconnecting while the Core comes back and Offline when there is none, and Connected once read", async () => {
    server.ready = false;
    server.coreState = "reconnecting";
    await mount([{ type: "qsys-status" }, FADER]);
    const said = () => q("qsys-status", "[data-connection]").dataset.connection;
    assert.equal(said(), "reconnecting");
    assert.equal(q("qsys-fader").dataset.state, "offline", "no input until the Core is read");
    cleanup();
    __resetQsysPanelsForTests();
    server.coreState = "offline";
    await mount([{ type: "qsys-status" }]);
    assert.equal(said(), "offline");
    server.ready = true;
    server.coreState = "connected";
    act(() => FakeEventSource.last!.push("qsys:status", { connected: true, state: "connected" }));
    await wait(40);
    assert.equal(said(), "connected");
  });
});

/** Every type but the status object, with no binding. Sorted, one per line. */
const UNBOUND: LayoutObjectConfig[] = [
  { type: "qsys-button", binding: null, label: "", hold: false },
  { type: "qsys-fader", binding: null, orientation: "vertical", showDb: true, steps: false, stepDb: 3 },
  { type: "qsys-label", binding: null, text: "" },
  { type: "qsys-meter", binding: null, form: "bar" },
  { type: "qsys-mute", binding: null },
  { type: "qsys-presets", items: [] },
  { type: "qsys-selector", items: [] },
  { type: "qsys-strip", name: null, label: "", gain: null, mute: null, meter: null },
  { type: "qsys-switch", binding: null, label: "" },
];

/** Every writing type, bound to controls the Core has but the allowlist does not. Sorted. */
const NOT_ALLOWED: LayoutObjectConfig[] = [
  { type: "qsys-button", binding: b("load_free"), label: "Go", hold: false },
  { type: "qsys-fader", binding: b("gain_free"), orientation: "vertical", showDb: true, steps: true, stepDb: 3 },
  { type: "qsys-mute", binding: b("mute_free") },
  { type: "qsys-presets", items: [{ label: "Free", binding: b("load_free") }] },
  { type: "qsys-selector", items: [{ label: "Free", binding: b("load_free") }] },
  { type: "qsys-strip", name: null, label: "Free", gain: b("gain_free"), mute: b("mute_free"), meter: null },
  { type: "qsys-switch", binding: b("mute_free"), label: "Free" },
];

describe("unavailable objects", () => {
  test("an unbound object of every type is greyed and says Not bound", async () => {
    await mount(UNBOUND);
    for (const c of UNBOUND) {
      const el = document.querySelector(`[data-qsys-object="${c.type}"][data-state="unavailable"]`) as HTMLElement | null;
      assert.ok(el, `${c.type} unbound is not unavailable`);
      assert.equal((el.querySelector("[data-qsys-body]") as HTMLElement).style.opacity, "0.35", `${c.type} unbound is not greyed`);
      assert.equal(el.querySelector("[data-unavailable]")?.textContent, "Not bound", `${c.type} does not say Not bound`);
    }
  });

  test("a writing object bound to a control not on the allowlist is Unavailable and writes nothing; a reading one stays live", async () => {
    await mount([...NOT_ALLOWED, { type: "qsys-meter", binding: b("gain_free"), form: "number" }, { type: "qsys-label", binding: b("zone_name"), text: "" }]);
    for (const c of NOT_ALLOWED) {
      const el = q(c.type);
      assert.equal(el.dataset.state, "unavailable", `${c.type} on a control not on the allowlist looks usable`);
      assert.equal(el.querySelector("[data-unavailable]")?.textContent, "Unavailable");
    }
    assert.equal(q("qsys-meter").dataset.state, "live", "a meter needs no allowlist (positive control)");
    assert.equal(q("qsys-label").dataset.state, "live");
    for (const c of NOT_ALLOWED) {
      // The word stands in for the control: nothing is left to press or drag.
      assert.equal(q(c.type).querySelectorAll("button, [data-fader]").length, 0, `${c.type} still draws a control`);
    }
    for (const el of document.querySelectorAll("button")) {
      act(() => {
        fireEvent.click(el);
      });
    }
    await wait(40);
    assert.equal(server.writes.length, 0);
  });
});

describe("the panel store against the Core", () => {
  test("a control the Core has but has not reported yet is held, not Unavailable", async () => {
    delete server.values.gain; // the first page to open the panel: the watch has not read it yet
    await mount([FADER]);
    assert.equal(q("qsys-fader").dataset.state, "offline");
    assert.equal(q("qsys-fader", "[data-unavailable]"), null, "flashed Unavailable while opening");
    push("qsys:values", [{ control: "gain", value: -9 }]);
    assert.equal(q("qsys-fader").dataset.state, "live");
    assert.equal(dbText(), "-9.0");
  });

  test("a push that lands while the release write is on its way wins over that write's read-back", async () => {
    let release: () => void = () => {};
    await mount([FADER]);
    server.holdWrites = (r) => (release = r);
    const fader = q("qsys-fader", "[data-fader]");
    down(fader, 100);
    move(80); // -8, sent
    await wait(5);
    release(); // the drag write's answer
    await wait(5);
    up(80); // the release: final -8, held unanswered
    await wait(5);
    push("qsys:values", [{ control: "gain", value: -30 }]); // someone else moved it meanwhile
    release(); // the release's read-back (-14) arrives after the push
    await wait(20);
    assert.equal(dbText(), "-30.0", "the page sat on its own value over the newer Core one");
  });

  test("a catalog that cannot be read is logged once and read again; the fader becomes usable", async () => {
    server.catalogFails = 2; // the mount's read and the read after the subscribe report
    await mount([FADER]);
    assert.equal(q("qsys-fader").dataset.state, "unavailable", "no range, so no usable fader yet");
    await wait(1_300);
    assert.equal(q("qsys-fader").dataset.state, "live", "the catalog was read again");
    assert.equal(f.logs.filter((l) => l.tag === "qsys" && /catalog/.test(l.message)).length, 1, "the failure reached /log once");
  });

  test("input opens only on a read sent after the server acknowledged the page's channels", async () => {
    let release: () => void = () => {};
    server.holdSubscribes = (r) => (release = r);
    await mount([FADER]);
    assert.ok(server.reads >= 1, "the panel was read at once, to draw (positive control)");
    assert.equal(q("qsys-fader").dataset.state, "offline", "input open before the server had the page's channels");
    server.values.gain = -3; // changed on the Core; no push reaches a page not yet subscribed
    server.holdSubscribes = null;
    release();
    await wait(40);
    assert.equal(q("qsys-fader").dataset.state, "live");
    assert.equal(dbText(), "-3.0", "the change made before the acknowledgement was read");
  });

  test("after a reconnect, input waits for the acknowledgement and the read after it", async () => {
    await mount([FADER]);
    let release: () => void = () => {};
    server.holdSubscribes = (r) => (release = r);
    stream(false);
    stream(true);
    await wait(40);
    assert.equal(q("qsys-fader").dataset.state, "offline", "open before the server had the channels again");
    server.values.gain = -11;
    server.holdSubscribes = null;
    release();
    await wait(40);
    assert.equal(q("qsys-fader").dataset.state, "live");
    assert.equal(dbText(), "-11.0");
  });
});

function hide() {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  act(() => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
}
function show() {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  act(() => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
}

describe("review fixes", () => {
  test("a second touch starts from the value on screen, not the Core's last report", async () => {
    await mount([FADER]);
    const releases: (() => void)[] = [];
    server.holdWrites = (r) => releases.push(r);
    const fader = q("qsys-fader", "[data-fader]");
    down(fader, 100);
    move(80); // -8 on screen
    up(80); // the release's final write is not answered yet
    await wait(10);
    assert.equal(dbText(), "-14.0", "the thumb stays where the finger left it");
    down(fader, 100); // a second touch while the Core has not answered
    move(99); // one pixel: 0.3 dB
    up(99);
    for (const r of releases.splice(0)) r();
    await wait(20);
    for (const r of releases.splice(0)) r();
    await wait(20);
    const values = server.writes.map((w) => w.body.value);
    assert.ok(!values.some((v) => typeof v === "number" && v < -17), `the second touch jumped back toward -20: ${JSON.stringify(values)}`);
    assert.equal(values.at(-1), -13.7);
  });

  test("hiding the page mid-hold ends it; nothing writes, and input waits for a fresh read on show", async () => {
    await mount([{ type: "qsys-button", binding: b("save"), label: "Save", hold: true }, FADER]);
    const btn = q("qsys-button", "button");
    act(() => {
      fireEvent.pointerDown(btn, { pointerId: 7 });
    });
    hide();
    assert.equal(q("qsys-fader").dataset.state, "offline", "a hidden panel is not live");
    await wait(HOLD_MS + 100); // the hold's time passes while hidden (an iPad asleep)
    let release: () => void = () => {};
    server.holdSubscribes = (r) => (release = r);
    show();
    await wait(30);
    assert.equal(q("qsys-fader").dataset.state, "offline", "input opened on show before the fresh read");
    server.holdSubscribes = null;
    release();
    await wait(40);
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 7 }));
    });
    assert.equal(server.writes.length, 0, "the hold begun before the hide wrote");
    assert.equal(q("qsys-fader").dataset.state, "live");
    act(() => {
      fireEvent.pointerDown(q("qsys-button", "button"), { pointerId: 8 });
    });
    await wait(HOLD_MS + 60);
    assert.equal(server.writes.length, 1, "a fresh hold after the read writes (positive control)");
  });

  test("a hold across a quick hide and show writes nothing, even once the panel is read again", async () => {
    await mount([{ type: "qsys-button", binding: b("save"), label: "Save", hold: true }, FADER]);
    act(() => {
      fireEvent.pointerDown(q("qsys-button", "button"), { pointerId: 12 });
    });
    await wait(50);
    hide();
    show();
    await wait(60);
    assert.equal(q("qsys-fader").dataset.state, "live", "read again well inside the hold (positive control)");
    await wait(HOLD_MS);
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 12 }));
    });
    assert.equal(server.writes.length, 0, "a hold begun before the hide completed after it");
  });

  test("a hold goes to keyboard: Space held for the full hold writes, let go early does not", async () => {
    await mount([{ type: "qsys-button", binding: b("save"), label: "Save", hold: true }]);
    const btn = q("qsys-button", "button");
    act(() => {
      fireEvent.keyDown(btn, { key: " " });
    });
    await wait(HOLD_MS / 2);
    act(() => {
      fireEvent.keyUp(btn, { key: " " });
    });
    await wait(HOLD_MS);
    assert.equal(server.writes.length, 0);
    act(() => {
      fireEvent.keyDown(btn, { key: " " });
    });
    await wait(HOLD_MS + 60);
    act(() => {
      fireEvent.keyUp(btn, { key: " " });
    });
    assert.equal(server.writes.length, 1);
  });

  test("sliding off a hold button lets go of it", async () => {
    await mount([{ type: "qsys-button", binding: b("save"), label: "Save", hold: true }]);
    act(() => {
      fireEvent.pointerDown(q("qsys-button", "button"), { pointerId: 9, clientX: 50, clientY: 50 });
    });
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 9, clientX: 500, clientY: 50 }));
    });
    await wait(HOLD_MS + 60);
    assert.equal(server.writes.length, 0);
  });

  test("a Boolean on a button is a momentary: true on press, false on release", async () => {
    await mount([{ type: "qsys-button", binding: b("talk"), label: "Talk", hold: false, press: "momentary" }]);
    const btn = q("qsys-button", "button");
    act(() => {
      fireEvent.pointerDown(btn, { pointerId: 10 });
    });
    await wait(20);
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 10 }));
    });
    await wait(20);
    assert.deepEqual(server.writes.map((w) => w.body.value), [true, false]);
  });

  test("a button with no saved press type is a trigger: no release is written", async () => {
    await mount([{ type: "qsys-button", binding: b("talk"), label: "Talk", hold: false }]);
    const btn = q("qsys-button", "button");
    act(() => {
      fireEvent.pointerDown(btn, { pointerId: 13 });
    });
    await wait(20);
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 13 }));
      fireEvent.click(btn);
    });
    await wait(40);
    assert.ok(!server.writes.some((w) => w.body.value === false), `a trigger wrote a release: ${JSON.stringify(server.writes.map((w) => w.body.value))}`);
  });

  test("a momentary pressed across a drop does not send its release after it", async () => {
    await mount([{ type: "qsys-button", binding: b("talk"), label: "Talk", hold: false, press: "momentary" }]);
    act(() => {
      fireEvent.pointerDown(q("qsys-button", "button"), { pointerId: 11 });
    });
    await wait(20);
    stream(false);
    stream(true);
    await wait(40);
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 11 }));
    });
    await wait(20);
    assert.deepEqual(server.writes.map((w) => w.body.value), [true], "a release from before the drop was sent after it");
  });

  test("a write object on a control the Core reports read-only is Unavailable", async () => {
    await mount([{ ...(FADER as object), binding: b("level_ro") } as LayoutObjectConfig, { type: "qsys-meter", binding: b("level_ro"), form: "number" }]);
    assert.equal(q("qsys-fader").dataset.state, "unavailable");
    assert.equal(q("qsys-meter").dataset.state, "live", "reading it is fine (positive control)");
  });

  test("a catalog changed while the page could not hear is read again on reconnect", async () => {
    await mount([FADER]);
    assert.equal(q("qsys-fader", "[data-fader]").getAttribute("aria-valuemin"), "-100");
    server.catalog = {
      ...CATALOG,
      components: [{ ...CATALOG.components[0], controls: CATALOG.components[0].controls.map((c) => (c.Name === "gain" ? { ...c, ValueMin: -60, ValueMax: 12 } : c)) }],
    };
    stream(false);
    stream(true);
    await wait(60);
    assert.equal(q("qsys-fader", "[data-fader]").getAttribute("aria-valuemin"), "-60", "the old range survived the reconnect");
  });

  test("a new catalog announced while live closes input until it is read", async () => {
    await mount([FADER]);
    act(() => FakeEventSource.last!.push("qsys:status", { connected: true, state: "connected", catalogAt: 1 }));
    await wait(40);
    assert.equal(q("qsys-fader").dataset.state, "live");
    let release: () => void = () => {};
    server.holdReads = (r) => (release = r);
    act(() => FakeEventSource.last!.push("qsys:status", { connected: true, state: "connected", catalogAt: 2 }));
    assert.equal(q("qsys-fader").dataset.state, "offline", "open against the old catalog");
    server.holdReads = null;
    release();
    await wait(40);
    assert.equal(q("qsys-fader").dataset.state, "live");
  });

  test("the fader is a slider: its value is announced, and the arrow keys step it", async () => {
    await mount([FADER]);
    const slider = q("qsys-fader", "[role=slider]");
    assert.equal(slider.getAttribute("aria-valuenow"), "-20");
    assert.equal(slider.getAttribute("aria-valuetext"), "-20.0 dB");
    assert.equal(slider.getAttribute("aria-valuemax"), "0");
    act(() => {
      fireEvent.keyDown(slider, { key: "ArrowUp" });
    });
    await wait(20);
    assert.deepEqual(server.writes.map((w) => [w.body.value, w.body.final]), [[-17, true]], "one step of stepDb, final");
  });

  test("a meters-only strip draws its meters", async () => {
    await mount([{ type: "qsys-strip", name: null, label: "Room", gain: null, mute: null, meter: b("meter") }]);
    assert.equal(q("qsys-strip").dataset.state, "live");
    assert.ok(q("qsys-strip", "[data-meter]"), "no meter drawn");
  });

  test("a dense strip has the staff tick scale and an M mute", async () => {
    await mount([{ type: "qsys-strip", name: null, label: "Mic 1", gain: b("gain"), mute: b("mute"), meter: b("meter"), meter2: b("meter"), density: "dense" }]);
    assert.deepEqual([...document.querySelectorAll("[data-tick]")].map((t) => t.textContent), ["0", "-12", "-24", "-36", "-48", "-60"], "the -60..0 dB scale, a mark every 12 dB");
    const mute = q("qsys-strip", "[data-mute]");
    assert.equal(mute.textContent, "M");
    assert.equal(mute.getAttribute("aria-label"), "Mute");
    assert.equal(document.querySelectorAll('[data-qsys-object="qsys-strip"] [data-meter]').length, 2);
  });

  test("a release's read-back is not undone by the Core echoing a drag value", async () => {
    await mount([FADER]);
    const releases: (() => void)[] = [];
    server.holdWrites = (r) => releases.push(r);
    const fader = q("qsys-fader", "[data-fader]");
    down(fader, 100);
    move(90); // -17, sent
    await wait(5);
    releases.shift()!();
    await wait(5);
    move(80);
    up(80); // final -8, unanswered
    await wait(10);
    push("qsys:values", [{ control: "gain", value: -17 }]); // the Core's poll still shows the drag value
    for (const r of releases.splice(0)) r();
    await wait(20);
    assert.equal(dbText(), "-14.0", "the echo of the page's own drag write beat the release's read-back");
  });

  test("a refusal from the Core mid-drag ends the drag: one refused write, not one per sample", async () => {
    server.answer = (body) => (body.final === false ? { ok: false, reason: "core-error", message: "the Core refused" } : { ok: true, value: body.value, string: "", clamped: false });
    await mount([FADER]);
    down(q("qsys-fader", "[data-fader]"), 100);
    for (let y = 99; y > 60; y--) {
      move(y);
      await wait(3);
    }
    up(60);
    await wait(60);
    assert.equal(server.writes.length, 1, `${server.writes.length} writes reached the server`);
  });

  test("an allowlist that cannot be read is logged once per run", async () => {
    server.allowFails = true;
    server.ready = false; // keeps the panel re-reading
    const before = f.logs.filter((l) => /allowlist/.test(l.message)).length;
    await mount([FADER]);
    await wait(1_200);
    assert.ok(server.reads >= 3, "it read again (positive control)");
    assert.equal(f.logs.filter((l) => /allowlist/.test(l.message)).length - before, 1);
  });

  test("values flowing while the server is not ready do not re-read back to back", async () => {
    await mount([FADER]);
    server.ready = false;
    act(() => FakeEventSource.last!.push("qsys:status", { connected: true, state: "connected" }));
    await wait(30);
    const reads = server.reads;
    for (let i = 0; i < 10; i++) {
      push("qsys:values", [{ control: "gain", value: -20 + i }]);
      await wait(5);
    }
    assert.ok(server.reads - reads <= 1, `${server.reads - reads} reads for ten pushes`);
  });

  test("under StrictMode the panel watches once, goes live and writes nothing", async () => {
    const ctx = makeRenderCtx({ interactive: true, embedChain: ["v1"] });
    render(React.createElement(React.StrictMode, null, React.createElement(ObjectContent as never, { o: obj(FADER), ctx })));
    await wait(250);
    assert.equal(q("qsys-fader").dataset.state, "live");
    assert.ok(server.subscribes.at(-1)?.includes("qsys:watch:v1"));
    assert.equal(server.writes.length, 0);
  });
});

describe("review round 2", () => {
  test("a second finger on a hold button neither restarts the hold nor lets the first one's timer write", async () => {
    await mount([{ type: "qsys-button", binding: b("save"), label: "Save", hold: true }]);
    const btn = q("qsys-button", "button");
    act(() => {
      fireEvent.pointerDown(btn, { pointerId: 3 });
      fireEvent.pointerDown(btn, { pointerId: 4 });
    });
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 3 }));
    });
    await wait(HOLD_MS + 80);
    assert.equal(server.writes.length, 0, "a hold let go of at once still wrote");
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 4 }));
    });
  });

  test("a second press on a momentary does not release it while the first is held", async () => {
    await mount([{ type: "qsys-button", binding: b("talk"), label: "Talk", hold: false, press: "momentary" }]);
    const btn = q("qsys-button", "button");
    act(() => {
      fireEvent.pointerDown(btn, { pointerId: 5 });
    });
    act(() => {
      fireEvent.keyDown(btn, { key: " " });
      fireEvent.keyUp(btn, { key: " " });
    });
    await wait(20);
    assert.deepEqual(server.writes.map((w) => w.body.value), [true], "the key's press and release acted on the finger's press");
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 5 }));
    });
    await wait(20);
    assert.deepEqual(server.writes.map((w) => w.body.value), [true, false]);
  });

  test("focus leaving mid-press lets go: a hold does not complete, a momentary is released", async () => {
    await mount([{ type: "qsys-button", binding: b("save"), label: "Save", hold: true }, { type: "qsys-button", binding: b("talk"), label: "Talk", hold: false, press: "momentary" }]);
    const [hold, talk] = [...document.querySelectorAll('[data-qsys-object="qsys-button"] button')] as HTMLElement[];
    act(() => {
      fireEvent.keyDown(hold, { key: "Enter" });
      fireEvent.blur(hold);
    });
    await wait(HOLD_MS + 60);
    assert.equal(server.writes.length, 0, "a hold whose key was never let go here still wrote");
    act(() => {
      fireEvent.keyDown(talk, { key: " " });
    });
    await wait(20);
    act(() => {
      fireEvent.blur(talk);
    });
    await wait(20);
    assert.deepEqual(server.writes.map((w) => w.body.value), [true, false]);
  });

  test("a catalog announced while a read is out: that read opens nothing; the read after it does", async () => {
    await mount([FADER]);
    act(() => FakeEventSource.last!.push("qsys:status", { connected: true, state: "connected", catalogAt: 1 }));
    await wait(40);
    const releases: (() => void)[] = [];
    server.holdReads = (r) => releases.push(r);
    act(() => FakeEventSource.last!.push("qsys:status", { connected: true, state: "connected", catalogAt: 1 })); // a read goes out
    await wait(10);
    act(() => FakeEventSource.last!.push("qsys:status", { connected: true, state: "connected", catalogAt: 2 })); // redeployed meanwhile
    releases.shift()!(); // the read sent before the new catalog answers
    await wait(30);
    assert.equal(q("qsys-fader").dataset.state, "offline", "a read from before the new catalog reopened input");
    server.holdReads = null;
    for (const r of releases.splice(0)) r();
    await wait(60);
    assert.equal(q("qsys-fader").dataset.state, "live", "the read after the announcement opens it (positive control)");
  });

  test("a server that never acknowledges the channels does not hold the panel shut, and /log is told", async () => {
    __setSubscribedDeadlineForTests(100);
    let release: () => void = () => {};
    server.holdSubscribes = (r) => (release = r);
    const before = f.logs.filter((l) => l.tag === "qsys" && /acknowledge/.test(l.message)).length;
    try {
      await mount([FADER]);
      assert.equal(q("qsys-fader").dataset.state, "offline");
      await wait(200);
      assert.equal(q("qsys-fader").dataset.state, "live", "the panel stayed shut waiting for an acknowledgement");
      assert.equal(f.logs.filter((l) => l.tag === "qsys" && /acknowledge/.test(l.message)).length - before, 1);
    } finally {
      __setSubscribedDeadlineForTests(null);
      server.holdSubscribes = null;
      release();
    }
  });

  test("a break with a release still out shows the Core's value after the re-read, not the finger's", async () => {
    await mount([FADER]);
    const releases: (() => void)[] = [];
    server.holdWrites = (r) => releases.push(r);
    down(q("qsys-fader", "[data-fader]"), 100);
    move(80);
    await wait(5);
    releases.shift()!();
    up(80); // the release's final write stays out
    await wait(5);
    server.values.gain = -25; // the Core, as read again after the break
    stream(false);
    stream(true);
    await wait(60);
    assert.equal(dbText(), "-25.0", "the finger's value outlived the break");
    server.holdWrites = null;
    for (const r of releases.splice(0)) r();
    await wait(20);
    assert.equal(dbText(), "-25.0", "the late answer put the finger's value back");
  });

  test("a momentary press asks for a lease, renews it while held, and stops renewing on release or a break", async () => {
    await mount([{ type: "qsys-button", binding: b("talk"), label: "Talk", hold: false, press: "momentary" }]);
    const btn = q("qsys-button", "button");
    act(() => {
      fireEvent.pointerDown(btn, { pointerId: 6 });
    });
    await wait(1_150);
    assert.equal(server.writes[0].body.lease, true);
    assert.equal(typeof server.writes[0].body.cid, "string", "the press names its stream");
    assert.ok(server.renewals >= 1, "no renewal while held");
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 6 }));
    });
    const after = server.renewals;
    await wait(1_150);
    assert.equal(server.renewals, after, "renewed after the release");
    assert.equal(server.writes[1].body.lease, undefined, "the release took a lease");

    act(() => {
      fireEvent.pointerDown(btn, { pointerId: 7 });
    });
    await wait(20);
    stream(false); // a break mid-press: the renewals stop, so the server's lease lapses
    const atBreak = server.renewals;
    await wait(1_150);
    assert.equal(server.renewals, atBreak, "renewed across a break");
    stream(true);
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 7 }));
    });
  });
});

describe("review round 3", () => {
  test("renewals name the page's stream, and stop once the server says no lease is held", async () => {
    await mount([{ type: "qsys-button", binding: b("talk"), label: "Talk", hold: false, press: "momentary" }]);
    server.leaseHeld = false; // the press took no lease (or it ended)
    act(() => {
      fireEvent.pointerDown(q("qsys-button", "button"), { pointerId: 21 });
    });
    await wait(1_150);
    assert.equal(server.renewals, 1, "one renewal, answered held: false");
    assert.equal(server.renewCids[0], server.writes[0].body.cid, "the renewal names the stream the press named");
    await wait(1_100);
    assert.equal(server.renewals, 1, "kept renewing a lease the server does not hold");
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 21 }));
    });
  });
});

describe("review round 4: a held momentary keeps renewing until its own release", () => {
  const talk = () => mount([{ type: "qsys-button", binding: b("talk"), label: "Talk", hold: false, press: "momentary" }]);
  const down = (pointerId: number) =>
    act(() => {
      fireEvent.pointerDown(q("qsys-button", "button"), { pointerId });
    });
  const up = (pointerId: number) =>
    act(() => {
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId }));
    });

  test("a renewal that gets no answer is tried again shortly, and the renewals go on", async () => {
    await talk();
    server.renewFails = 1;
    down(31);
    // The retry is due at 1.3 s and the next tick at 2 s: 1.65 s sits between them.
    await wait(1_650);
    assert.ok(server.renewals >= 2, `a failed renewal was not retried before the next tick (${server.renewals} renewals by 1.65 s)`);
    await wait(700);
    assert.ok(server.renewals >= 3, `one failed renewal stopped the renewals (${server.renewals} by 2.35 s)`);
    up(31);
  });

  test("a renewal answered before the press's own write has answered does not end the hold", async () => {
    await talk();
    let answer: () => void = () => {};
    server.holdWrites = (r) => (answer = r);
    server.leaseHeld = false; // the press has not landed, so no lease yet
    down(32);
    await wait(1_150);
    assert.equal(server.renewals, 1);
    server.leaseHeld = true;
    server.holdWrites = null;
    answer();
    await wait(1_000);
    assert.ok(server.renewals >= 2, `an early "not held" ended the renewals of a press still on its way (${server.renewals})`);
    up(32);
  });

  test("a stale \"not held\" from the previous press does not stop the next press's renewals", async () => {
    await talk();
    let answer: () => void = () => {};
    server.holdRenewals = (r) => (answer = r);
    down(33);
    await wait(1_150);
    assert.equal(server.renewals, 1, "press 1's renewal");
    up(33);
    server.holdRenewals = null;
    down(34);
    await wait(20);
    server.leaseHeld = false; // press 1's lease ended with its release
    answer();
    await wait(20);
    server.leaseHeld = true;
    const before = server.renewals;
    await wait(1_150);
    assert.ok(server.renewals > before, "press 1's late answer stopped press 2's renewals");
    up(34);
  });
});
