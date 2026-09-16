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

import { installDom } from "../test-dom.js";

const teardown = installDom();
class NoStream {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");
const { cueButtonDeps } = await import("./cue-button.js");
type CuesLive = import("./use-cue-live.js").CuesLive;
type ManifestSwitch = CuesLive["manifest"]["switches"][number];
type LiveState = import("./use-cue-live.js").LiveState;

after(() => {
  cleanup();
  teardown();
});

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
 */
const settle = () => new Promise((r) => setTimeout(r, 20));

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
