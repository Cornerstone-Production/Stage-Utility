// The cue button has to SAY the state, and press the right half. Rendered,
// because the defect this guards is a lamp that lights for the wrong reason.
//
// NOT unit-tested here, and checked in a browser instead: how the button LOOKS.
// jsdom loads no stylesheet, so every CSS variable resolves to "" and every
// offsetHeight reads 0 — a guard over the green ring or the amber dashed ring
// would assert a string this file wrote to itself. The states are asserted
// through `data-state`, which is the same value the colours are chosen from.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();
// React only act-wraps a render, and only warns when an update escapes one,
// once it is told it is in a test environment. Without this the file reads
// as clean while 8 updates land outside act.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoStream {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");
const { cueButtonDeps } = await import("./cue-button.js");
type CuesLive = import("./use-cue-live.js").CuesLive;
type ManifestSwitch = CuesLive["manifest"]["switches"][number];
type LiveState = import("./use-cue-live.js").LiveState;

after(() => unmountAndTeardown(cleanup, teardown));

function live(over: Partial<ManifestSwitch> = {}, state?: LiveState): CuesLive {
  const sw: ManifestSwitch = {
    id: "haze",
    name: "Haze",
    room: "Stage",
    on: "haze_on",
    off: "haze_off",
    toggle: false,
    state: "off",
    available: true,
    stateSource: "companion:haze",
    ...over,
  };
  return {
    manifest: {
      version: 1,
      server: { name: "t", lanUrl: null },
      switches: [sw],
      buttons: [{ id: "confetti", name: "Confetti", room: "", cue: "confetti", available: true }],
    },
    states: new Map<string, LiveState>([["haze", state ?? { state: sw.state }]]),
  };
}

function mount(cues: CuesLive | null, cue: string, interactive = true) {
  cleanup();
  const ctx = makeRenderCtx({ cues, interactive });
  const obj = {
    id: "o1",
    x: 0,
    y: 0,
    w: 0.1,
    h: 0.5,
    z: 1,
    config: { type: "cue-button", cue, showDevice: true },
    style: {},
  } as never;
  return render(React.createElement(ObjectContent as never, { o: obj, ctx }));
}

/**
 * Let the press settle: the call promise, React's state update, and the render
 * it schedules. Two macrotasks rather than one — with a single tick the last
 * setState landed after the test had ended, and node:test reported the render
 * as "asynchronous activity after the test ended" once the dom was torn down.
 *
 * act()-wrapped so that setState lands on React's own queue instead of the
 * scheduler — without it, the same race can land the flush after teardown
 * instead of merely after the test.
 */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

const stateOf = (container: HTMLElement) =>
  container.querySelector("[data-state]")?.getAttribute("data-state");

describe("cue button", () => {
  test("unbound says so and fires nothing", async () => {
    let calls = 0;
    cueButtonDeps.call = async () => {
      calls++;
      return { status: 200, ok: true, detail: "" };
    };
    const { container } = mount(live(), "");
    assert.match(container.textContent ?? "", /Unbound/);
    fireEvent.click(container.querySelector("button")!);
    await settle();
    assert.equal(calls, 0);
  });

  test("each state is named on the button", () => {
    // "idle", not "off": a momentary button at rest and a switch that is off
    // draw the same, which is what the state name says. (The plan's draft of
    // this case asserted "off", a name CueButtonState does not have.)
    assert.equal(stateOf(mount(live({}, { state: "off" }), "haze").container), "idle");
    assert.equal(stateOf(mount(live({}, { state: "on" }), "haze").container), "on");
    assert.equal(
      stateOf(mount(live({}, { state: "off", settling: true, commanded: "on" }), "haze").container),
      "settling",
    );
    const stale = mount(
      live({}, { state: "unknown", reason: "Companion: Connection Failure" }),
      "haze",
    );
    assert.equal(stateOf(stale.container), "stale");
    assert.match(stale.container.textContent ?? "", /Connection Failure/);
    assert.equal(stateOf(mount(live({ available: false }), "haze").container), "unavailable");
  });

  test("a switch that is off presses ON, one that is on presses OFF", async () => {
    const names: string[] = [];
    cueButtonDeps.call = async (n) => {
      names.push(n);
      return { status: 200, ok: true, detail: "dispatched" };
    };
    fireEvent.click(mount(live({}, { state: "off" }), "haze").container.querySelector("button")!);
    fireEvent.click(mount(live({}, { state: "on" }), "haze").container.querySelector("button")!);
    fireEvent.click(mount(live(), "confetti").container.querySelector("button")!);
    await settle();
    assert.deepEqual(names, ["haze_on", "haze_off", "confetti"]);
  });

  test("a reading nobody can trust presses ON, not the opposite of a guess", async () => {
    const names: string[] = [];
    cueButtonDeps.call = async (n) => {
      names.push(n);
      return { status: 200, ok: true, detail: "dispatched" };
    };
    fireEvent.click(
      mount(live({}, { state: "unknown", reason: "Connection Failure" }), "haze").container.querySelector(
        "button",
      )!,
    );
    await settle();
    assert.deepEqual(names, ["haze_on"]);
  });

  test("unavailable does not fire; a wall display does not fire", async () => {
    let calls = 0;
    cueButtonDeps.call = async () => {
      calls++;
      return { status: 200, ok: true, detail: "" };
    };
    fireEvent.click(mount(live({ available: false }), "haze").container.querySelector("button")!);
    fireEvent.click(mount(live(), "haze", false).container.querySelector("button")!);
    await settle();
    assert.equal(calls, 0);
  });

  test("a refusal is shown, not swallowed", async () => {
    cueButtonDeps.call = async () => ({
      status: 409,
      error: "Not allowed during a service",
      reason: "service-live",
    });
    const { container } = mount(live(), "haze");
    fireEvent.click(container.querySelector("button")!);
    await settle();
    assert.match(container.textContent ?? "", /Not allowed during a service/);
  });

  test("a call that never answers is shown too", async () => {
    // The one case a caught error is the only evidence: the fetch itself threw,
    // so there is no body to read a reason out of.
    cueButtonDeps.call = async () => {
      throw new Error("Failed to fetch");
    };
    const { container } = mount(live(), "haze");
    fireEvent.click(container.querySelector("button")!);
    await settle();
    assert.match(container.textContent ?? "", /Could not reach the server/);
  });

  test("a confirmation the panel cannot give says where to go", async () => {
    cueButtonDeps.call = async () => ({ status: 202, detail: "awaiting confirmation" });
    const { container } = mount(live(), "haze");
    fireEvent.click(container.querySelector("button")!);
    await settle();
    assert.match(container.textContent ?? "", /confirmation/i);
  });
});

describe("the live tone", () => {
  // The INLINE colours ARE asserted. jsdom resolves no custom property, but it
  // keeps an inline `box-shadow: … var(--red-9)` verbatim, so "which token did
  // this button choose" is a real question it can answer — and it is the whole
  // decision the tone exists to make. What jsdom still cannot answer is what
  // those tokens LOOK like and whether the ring is visible against the button's
  // own fill; that was checked in a browser.
  const toneOf = (container: HTMLElement) =>
    container.querySelector("[data-state]")?.getAttribute("data-tone");
  const ringOf = (container: HTMLElement) =>
    (container.querySelector("[data-state]") as HTMLElement).style.boxShadow;
  /** The lamp: the first span, which the button renders aria-hidden. */
  const dotOf = (container: HTMLElement) =>
    (container.querySelector("[data-state] span[aria-hidden]") as HTMLElement).style.background;

  test("a live switch says so, in every state", () => {
    for (const state of [{ state: "on" as const }, { state: "off" as const }]) {
      assert.equal(toneOf(mount(live({ tone: "live" }, state), "haze").container), "live");
    }
    assert.equal(
      toneOf(mount(live({ tone: "live" }, { state: "unknown", reason: "gone" }), "haze").container),
      "live",
    );
  });

  test("a switch without one is unchanged", () => {
    assert.equal(toneOf(mount(live({}, { state: "on" }), "haze").container), null);
    assert.equal(stateOf(mount(live({}, { state: "on" }), "haze").container), "on");
  });

  test("a button never carries one", () => {
    // Momentary: there is nothing to read back, so there is no on state to
    // colour, and a tone on it would be a lamp that never lights.
    assert.equal(toneOf(mount(live(), "confetti").container), null);
  });

  test("on is red, ring and dot", () => {
    // RED, not green. A recording in progress and a projector that is on are
    // not the same fact, and the whole point of the tone is that a lit console
    // button reads as "we are live" rather than "this is working".
    const { container } = mount(live({ tone: "live" }, { state: "on" }), "haze");
    assert.match(ringOf(container), /var\(--red-9\)/);
    assert.equal(dotOf(container), "var(--red-9)");
  });

  test("off is the green standby ring", () => {
    // The device answered, and said it is not recording: connected and standing
    // by. The dot stays the faint one — the ring is what says standby, and a
    // green dot here would be indistinguishable from an ordinary switch that is
    // ON.
    const { container } = mount(live({ tone: "live" }, { state: "off" }), "haze");
    assert.match(ringOf(container), /var\(--green-9\)/);
    assert.equal(dotOf(container), "var(--su-fg-faint)");
  });

  test("an unreadable live switch is the amber ring, not a green one", () => {
    // `stale` is "nobody can say", and a green standby ring over a recorder
    // nobody can reach is the exact claim this must never make.
    const { container } = mount(
      live({ tone: "live" }, { state: "unknown", reason: "gone" }),
      "haze",
    );
    assert.match(ringOf(container), /var\(--amber-9\)/);
  });

  test("a switch without a tone is green on and unringed off", () => {
    const on = mount(live({}, { state: "on" }), "haze");
    assert.match(ringOf(on.container), /var\(--green-9\)/);
    assert.equal(dotOf(on.container), "var(--green-9)");
    const off = mount(live({}, { state: "off" }), "haze");
    assert.equal(ringOf(off.container), "", "an ordinary switch grew a ring when off");
    assert.equal(dotOf(off.container), "var(--su-fg-faint)");
  });

  test("its on and off states are still the ordinary ones", () => {
    // The tone changes the COLOUR and nothing else: the press, the states and
    // the halves are exactly a default switch's.
    assert.equal(stateOf(mount(live({ tone: "live" }, { state: "on" }), "haze").container), "on");
    assert.equal(stateOf(mount(live({ tone: "live" }, { state: "off" }), "haze").container), "idle");
    assert.equal(
      stateOf(
        mount(live({ tone: "live" }, { state: "unknown", reason: "gone" }), "haze").container,
      ),
      "stale",
    );
  });
});
