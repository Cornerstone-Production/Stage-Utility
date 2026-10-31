// A Home tile's own action: Start and Stop on a recorder, Prev and Next on the
// live timer.
//
// There is no fake Reaper in this repository, so the action invoke is a stubbed
// fetch that records every request. What is asserted is the request the press
// makes (or does not make) and what the tile then says; REAPER's own answer
// arrives as the `chosen` prop, which is what `reaper:status` feeds in the app.
//
// NOT unit-tested, on purpose: the 44px touch size and the narrow-tile drop of
// the action column. Both are CSS (`coarse:` and a container query), jsdom
// loads no stylesheet and reports every size as 0, so a test over the class
// string would pass on a button that renders at 32px. They are measured in a
// browser with a coarse pointer, see the commit.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { RecordingAction, StepAction, STOP_CONFIRM_MS, ACTION_NOTE_MS, CONFIRM_GIVE_UP_MS } = await import(
  "./card-actions.js"
);

after(() => unmountAndTeardown(cleanup, teardown));

interface Req { url: string; body: unknown }
let requests: Req[] = [];
let answer: (url: string) => unknown = () => ok({ ok: true, detail: "" });
const realFetch = globalThis.fetch;

beforeEach(() => {
  requests = [];
  answer = () => ok({ ok: true, detail: "" });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return answer(url);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  mock.timers.reset();
  globalThis.fetch = realFetch;
});

const reaper = (over: Partial<{ connected: boolean; recording: boolean }> = {}) => ({
  name: "REAPER", connected: true, recording: false, timecode: null, ...over,
});
const invokes = () => requests.filter((r) => r.url.endsWith("/api/action/invoke"));

function tile(chosen: ReturnType<typeof reaper>[]) {
  return React.createElement(RecordingAction, { chosen });
}

describe("Stop takes two presses", () => {
  test("one press does not stop; the second, within 3 seconds, does", async () => {
    render(tile([reaper({ recording: true })]));
    mock.timers.enable({ apis: ["setTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    assert.equal(invokes().length, 0, "the first press must only ask");
    assert.ok(screen.getByRole("button", { name: "Stop recording?" }));
    act(() => mock.timers.tick(STOP_CONFIRM_MS - 100));
    fireEvent.click(screen.getByRole("button", { name: "Stop recording?" }));
    mock.timers.reset();
    await settle();
    assert.equal(invokes().length, 1);
    assert.deepEqual(invokes()[0]?.body, { actionId: "reaper.transport", params: { command: "stop" } });
  });

  test("two presses 4 seconds apart do not stop", async () => {
    render(tile([reaper({ recording: true })]));
    mock.timers.enable({ apis: ["setTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    act(() => mock.timers.tick(4000));
    // The ask has lapsed: this is a first press again, not a confirmation.
    const again = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(again);
    mock.timers.reset();
    await settle();
    assert.equal(invokes().length, 0);
    assert.ok(screen.getByRole("button", { name: "Stop recording?" }));
  });

  test("a recorder that restarts inside the window is not stopped by one press", async () => {
    const { rerender } = render(tile([reaper({ recording: true })]));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    assert.ok(screen.getByRole("button", { name: "Stop recording?" }));
    // Stopped by somebody else, then started again, all inside 3 seconds.
    rerender(tile([reaper({ recording: false })]));
    rerender(tile([reaper({ recording: true })]));
    await settle();
    assert.ok(screen.getByRole("button", { name: "Stop" }), "the ask was about a recording that ended");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    assert.equal(invokes().length, 0, "one press only asks again");
  });

  test("OBS stops through its own action", async () => {
    render(tile([{ name: "OBS", connected: true, recording: true, timecode: null }]));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop recording?" }));
    await settle();
    assert.deepEqual(invokes()[0]?.body, { actionId: "obs.record", params: { command: "stop" } });
  });
});

describe("Start", () => {
  test("spins until the recorder reports it is recording, then offers Stop", async () => {
    const { rerender } = render(tile([reaper()]));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await settle();
    assert.deepEqual(invokes()[0]?.body, { actionId: "reaper.transport", params: { command: "record" } });
    // The request was accepted. That is not the recording.
    assert.ok(screen.getByRole("button", { name: "Starting" }), "must not read as done on an accepted request");
    assert.ok(screen.queryByRole("button", { name: "Stop" }) === null);
    rerender(tile([reaper({ recording: true })]));
    await settle();
    assert.ok(screen.getByRole("button", { name: "Stop" }));
  });

  test("a press that has landed does not come back when the recorder later changes", async () => {
    const { rerender } = render(tile([reaper()]));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await settle();
    rerender(tile([reaper({ recording: true })]));
    await settle();
    // Somebody stops it at the console. That is not our press still waiting.
    rerender(tile([reaper({ recording: false })]));
    await settle();
    assert.ok(screen.queryByRole("button", { name: "Starting" }) === null, "no phantom spinner");
    assert.ok(screen.getByRole("button", { name: "Start" }));
  });

  test("says so when the recorder never confirms", async () => {
    render(tile([reaper()]));
    mock.timers.enable({ apis: ["setTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await act(async () => { await Promise.resolve(); });
    act(() => mock.timers.tick(CONFIRM_GIVE_UP_MS));
    assert.match(screen.getByRole("alert").textContent ?? "", /Reaper did not confirm/);
  });

  test("with two recorders chosen, it spins until BOTH report recording", async () => {
    const obs = (recording: boolean) => ({ name: "OBS", connected: true, recording, timecode: null });
    const { rerender } = render(tile([reaper(), obs(false)]));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await settle();
    assert.equal(invokes().length, 2, "each recorder is told");
    rerender(tile([reaper({ recording: true }), obs(false)]));
    await settle();
    assert.ok(screen.getByRole("button", { name: "Starting" }), "one of two is not done");
    rerender(tile([reaper({ recording: true }), obs(true)]));
    await settle();
    assert.ok(screen.getByRole("button", { name: "Stop" }));
  });

  test("a refusal clears the spinner and says why, when the status never moves", async () => {
    answer = () => ok({ ok: false, detail: "REAPER is not connected" });
    render(tile([reaper()]));
    mock.timers.enable({ apis: ["setTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    assert.match(screen.getByRole("alert").textContent ?? "", /not connected/);
    assert.ok(screen.queryByRole("button", { name: "Starting" }) === null, "the spinner must clear");
    // And it stays cleared once the note has gone, not hiding behind it.
    act(() => mock.timers.tick(ACTION_NOTE_MS));
    assert.ok(screen.queryByRole("alert") === null);
    assert.ok(screen.queryByRole("button", { name: "Starting" }) === null, "no spinner under the note");
    assert.ok(screen.getByRole("button", { name: "Start" }));
  });

  test("a refusal that lands after the recorder is already recording shows no failure", async () => {
    let release: (v: unknown) => void = () => {};
    answer = () => new Promise((r) => { release = r; });
    const { rerender } = render(tile([reaper()]));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await settle();
    rerender(tile([reaper({ recording: true })]));
    await settle();
    release(ok({ ok: false, detail: "already recording" }));
    await settle();
    assert.ok(screen.queryByRole("alert") === null, "a note over a working recorder is a lie");
  });

  test("a recorder that disconnects or vanishes mid-Stop finishes the press at once", async () => {
    const obs = (recording: boolean) => ({ name: "OBS", connected: true, recording, timecode: null });
    for (const gone of [reaper({ recording: true, connected: false }), null]) {
      const { rerender, unmount } = render(tile([reaper({ recording: true }), obs(true)]));
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      fireEvent.click(screen.getByRole("button", { name: "Stop recording?" }));
      await settle();
      assert.ok(screen.getByRole("button", { name: "Stopping" }));
      // OBS stops; REAPER is gone and would never report recording: false.
      rerender(tile([...(gone ? [gone] : []), obs(false)]));
      await settle();
      assert.ok(screen.queryByRole("button", { name: "Stopping" }) === null, "a gone recorder is not recording");
      unmount();
    }
  });

  test("a recorder that disconnects mid-Start is named at the give-up", async () => {
    const obs = (recording: boolean) => ({ name: "OBS", connected: true, recording, timecode: null });
    const { rerender } = render(tile([reaper(), obs(false)]));
    mock.timers.enable({ apis: ["setTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await act(async () => { await Promise.resolve(); });
    rerender(tile([reaper({ connected: false }), obs(true)]));
    act(() => mock.timers.tick(CONFIRM_GIVE_UP_MS));
    assert.match(screen.getByRole("alert").textContent ?? "", /Reaper disconnected/);
  });

  test("a recorder that is not connected offers nothing", () => {
    render(tile([reaper({ connected: false })]));
    assert.ok(screen.queryByRole("button") === null);
  });
});

describe("a failed action", () => {
  test("says so on the tile for 5 seconds", async () => {
    answer = () => { throw new TypeError("fetch failed"); };
    render(tile([reaper()]));
    mock.timers.enable({ apis: ["setTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.match(screen.getByRole("alert").textContent ?? "", /Reaper did not answer/);
    act(() => mock.timers.tick(ACTION_NOTE_MS));
    assert.ok(screen.queryByRole("alert") === null, "and then it clears");
  });

  test("an action the server refuses reports the server's reason", async () => {
    answer = () => ok({ ok: false, detail: "REAPER is not connected" });
    render(tile([reaper()]));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await settle();
    assert.match(screen.getByRole("alert").textContent ?? "", /REAPER is not connected/);
  });
});

describe("Prev and Next", () => {
  test("Next is one press, and calls the live endpoint", async () => {
    render(React.createElement(StepAction, { showPrev: true }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await settle();
    assert.equal(requests.filter((r) => r.url.endsWith("/api/live/next")).length, 1);
  });

  test("Prev is there at medium and up, and absent on a small tile", async () => {
    render(React.createElement(StepAction, { showPrev: true }));
    fireEvent.click(screen.getByRole("button", { name: /Prev/ }));
    await settle();
    assert.equal(requests.filter((r) => r.url.endsWith("/api/live/previous")).length, 1);
    cleanup();
    render(React.createElement(StepAction, { showPrev: false }));
    assert.ok(screen.queryByRole("button", { name: /Prev/ }) === null);
    assert.ok(screen.getByRole("button", { name: /Next/ }));
  });

  test("a failed Next says so on the tile", async () => {
    answer = () => { throw new TypeError("fetch failed"); };
    render(React.createElement(StepAction, { showPrev: true }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await settle();
    assert.match(screen.getByRole("alert").textContent ?? "", /PCO next failed/);
  });
});
