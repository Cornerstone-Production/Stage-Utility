// A row of status widgets has to agree about what "nothing is happening" looks
// like.
//
// The streaming widgets had THREE strengths where the recorders have two: a
// dimmed 45% when unreachable, full white when live-and-unfilled, and
// `--color-fg-muted` at 70% for off air in between. On a wall beside REAPER and
// OBS — which dim when they cannot be reached — off air was the brightest quiet
// thing in the row and read as the one still doing something. Reported twice.
//
// Quiet is one thing now: off air and unreachable read at the same strength,
// because both mean nothing is going out and the WORD says which.
//
// THIS FILE USED TO READ THE SOURCE, and matched `dim:\s*!live,` against the
// text of streamingReadout. That went red the moment a fourth state was added —
// on a change that kept every property above true — while a rewrite that
// reversed the meaning and kept the spelling would have stayed green. It renders
// the real widget now and reads the strengths off it. `dim` and `valueColor` are
// INLINE styles, so jsdom reports both without a stylesheet; the colours are
// `var(--…)` tokens here rather than resolved values, which is fine because what
// is asserted is which token, not what it looks like. What it LOOKS like was
// checked in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../test-dom.js";

const BOX_PX = 240;
const teardown = installRenderDom({ clientHeight: BOX_PX });
// The Readout sizes itself from its own box, which jsdom leaves at 0 — so every
// value would render at 0px and be dropped. Same patch status-tile-size.test.ts
// makes, for the same reason.
for (const [prop, px] of [["offsetHeight", BOX_PX], ["offsetWidth", 520]] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { get: () => px, configurable: true });
}

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");
const { ObjectContent } = await import("./layout-renderer.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
afterEach(async () => { cleanup(); await settle(); });

const NOW = Date.parse("2026-09-06T14:05:00.000Z");
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

const yt = (over: Record<string, unknown>) =>
  ({ connected: true, live: false, startedAt: null, detail: null, viewers: null, scheduledStartAt: null, ...over });

const obj = (config: Record<string, unknown>) =>
  ({ id: String(config.type), x: 0, y: 0, w: 1, h: 1, z: 0, config }) as never;

/** The value span's own strength and ink, off a real render. */
async function valueStyle(config: Record<string, unknown>, ctx: unknown): Promise<{ opacity: string; color: string }> {
  let container!: HTMLElement;
  await act(async () => {
    container = render(
      React.createElement(TooltipProvider as never, null, React.createElement(ObjectContent, { o: obj(config), ctx } as never)),
    ).container;
    await settle();
  });
  const el = container.querySelector<HTMLElement>("[data-readout-value] [style*='font-size']");
  assert.ok(el, `nothing rendered for ${String(config.type)}`);
  return { opacity: el!.style.opacity, color: el!.style.color };
}

/** Unfilled, so the value carries the colour rather than the box. Filled is the
 *  default and paints the value plain white, which would hide the distinction
 *  every assertion below is about. */
const STREAM = { type: "stream-status", platform: "youtube", fillWhenLive: false } as const;

describe("a streaming widget that is not live", () => {
  test("off air and unreachable read at exactly the same strength", async () => {
    // THE BUG. Off air used to sit at 70% between a dimmed 45% and full white,
    // so on a wall it was the brightest quiet thing in the row.
    const offAir = await valueStyle(STREAM, makeRenderCtx({ now: NOW, youtube: yt({}) } as never));
    const unreachable = await valueStyle(STREAM, makeRenderCtx({ now: NOW, youtube: null } as never));
    assert.equal(offAir.opacity, unreachable.opacity, "off air and unreachable are two different quiet strengths again");
    assert.equal(offAir.opacity, "0.45", `off air is at ${offAir.opacity}, not the dimmed strength the recorders wear`);
  });

  test("carries no third strength between dim and full", async () => {
    // Exactly two strengths across every state this widget has, and the count is
    // the assertion: a third would be a new one wherever it came from.
    const states = [
      await valueStyle(STREAM, makeRenderCtx({ now: NOW, youtube: null } as never)),
      await valueStyle(STREAM, makeRenderCtx({ now: NOW, youtube: yt({}) } as never)),
      await valueStyle(STREAM, makeRenderCtx({ now: NOW, youtube: yt({ scheduledStartAt: ago(372) }) } as never)),
      await valueStyle(STREAM, makeRenderCtx({ now: NOW, youtube: yt({ live: true, startedAt: ago(95) }) } as never)),
    ];
    assert.deepEqual(
      [...new Set(states.map((s) => s.opacity))].sort(),
      ["0.45", "1"],
      `the widget renders ${new Set(states.map((s) => s.opacity)).size} strengths: ${states.map((s) => s.opacity).join(", ")}`,
    );
  });

  test("colours the value only when it IS live", async () => {
    const live = await valueStyle(STREAM, makeRenderCtx({ now: NOW, youtube: yt({ live: true, startedAt: ago(95) }) } as never));
    assert.match(live.color, /--green-10/, "live is not green");
    for (const [name, youtube] of [["off air", yt({})], ["unreachable", null]] as const) {
      const quiet = await valueStyle(STREAM, makeRenderCtx({ now: NOW, youtube } as never));
      assert.doesNotMatch(quiet.color, /--green-/, `${name} is wearing the live colour`);
    }
  });
});

describe("off air past a scheduled start is the one quiet state that is not quiet", () => {
  // The fourth state, and the reason "dim everything that is not live" is no
  // longer the rule. Folding it back into the quiet branch would put the failure
  // this exists to show at the same strength as a Tuesday afternoon.
  const LATE = { now: NOW, youtube: yt({ scheduledStartAt: ago(372) }) };

  test("reads at full strength, not dimmed", async () => {
    const late = await valueStyle(STREAM, makeRenderCtx(LATE as never));
    assert.equal(late.opacity, "1", "a missed start was dimmed to the strength of an ordinary Tuesday");
  });

  test("takes the warn colour, and not the recorder's red", async () => {
    // One red on a wall carrying recorders and streams; this is amber.
    const late = await valueStyle(STREAM, makeRenderCtx(LATE as never));
    assert.match(late.color, /--color-warn-/, `a missed start is wearing ${late.color}`);
    assert.doesNotMatch(late.color, /--red-/, "a missed start took the recorder's red");
  });

  test("and a minute has not passed, it is still simply off air", async () => {
    const fresh = await valueStyle(STREAM, makeRenderCtx({ now: NOW, youtube: yt({ scheduledStartAt: ago(30) }) } as never));
    assert.equal(fresh.opacity, "0.45", "a stream thirty seconds late was reported as a failure");
  });
});

describe("the recorders it sits beside", () => {
  const OBS = { type: "obs-status", fillWhenRecording: false } as const;
  const obs = (over: Record<string, unknown>) =>
    ({ connected: true, recording: false, recordPaused: false, streaming: false, virtualCam: false, recordAnchorMs: null, recordSampledAt: null, ...over });

  test("dim when they cannot be reached — the strength off air now matches", async () => {
    const unreachable = await valueStyle(OBS, makeRenderCtx({ now: NOW, obs: obs({ connected: false }) } as never));
    assert.equal(unreachable.opacity, "0.45");
    const standby = await valueStyle(OBS, makeRenderCtx({ now: NOW, obs: obs({}) } as never));
    assert.equal(standby.opacity, "1", "a reachable recorder that is not rolling must not read as unreachable");
  });

  test("and use red, not green — one red on a wall carrying both", async () => {
    const rolling = await valueStyle(
      OBS,
      makeRenderCtx({ now: NOW, obs: obs({ recording: true, recordAnchorMs: 754_000, recordSampledAt: new Date(NOW).toISOString() }) } as never),
    );
    assert.match(rolling.color, /--red-(9|10)/);
    assert.doesNotMatch(rolling.color, /--green-/);
  });
});
