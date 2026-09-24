// The Transcription colors panel: every ProdCom channel, spoken or not, and the
// "Follow ProdCom's channel colors" switch.
//
// Driven with the real fetch/EventSource wiring faked (installDom + a stub
// EventSource + a fake /api/*), the same shape as use-stage-state.test.tsx and
// companion-status-line.test.tsx, so the panel, useStageState, useTranscript and
// useProdcomChannels all run for real — only the network is a stand-in.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

/** Mirrors use-stage-state.test.tsx's stub exactly: api.ts subscribes with
 *  `addEventListener(channel, handler)`, so tracking handlers here is what lets
 *  emit() below deliver a broadcast the way the server would. */
const listeners = new Map<string, Set<(e: { data: string }) => void>>();
class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  addEventListener(channel: string, handler: (e: { data: string }) => void): void {
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(handler);
  }
  removeEventListener(channel: string, handler: (e: { data: string }) => void): void {
    listeners.get(channel)?.delete(handler);
  }
  close(): void {
    this.readyState = 2;
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

function emit(channel: string, payload: unknown): void {
  const frame = { data: JSON.stringify(payload) };
  for (const handler of [...(listeners.get(channel) ?? [])]) handler(frame);
}

const CHANNELS: ProdcomChannelDTO[] = [
  { id: "CH-A", name: "Lead TB", color: "#00f900" },
  { id: "CH-B", name: "FOH TB", color: "#ff2600" },
  { id: "CH-C", name: "Cues", color: "#9437ff" },
];

let state: { captionChannelColors: Record<string, string>; followProdcomColors: boolean };
function resetState(): void {
  state = { captionChannelColors: {}, followProdcomColors: false };
}

const posts: { path: string; body: unknown }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (
  input: unknown,
  init?: { method?: string; body?: string },
) => {
  const path = String(input);
  const method = init?.method ?? "GET";
  const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) });

  if (method === "GET" && path === "/api/state") return json(state);
  if (method === "GET" && path === "/api/prodcom/transcript") return json([]);
  if (method === "GET" && path === "/api/prodcom/channels") return json(CHANNELS);

  const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  if (method === "POST") posts.push({ path, body });

  if (path === "/api/caption-colors") {
    const channel = body.channel as string;
    const color = body.color as string | null;
    if (color) state.captionChannelColors = { ...state.captionChannelColors, [channel]: color };
    else {
      const next = { ...state.captionChannelColors };
      delete next[channel];
      state.captionChannelColors = next;
    }
    emit("stage:state-changed", state);
    return json(state);
  }
  if (path === "/api/caption-colors/follow-prodcom") {
    state.followProdcomColors = body.on as boolean;
    emit("stage:state-changed", state);
    return json(state);
  }
  return json({ ok: true });
};

const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { CaptionColorsPanel } = await import("./caption-colors-panel.js");
const { TooltipProvider } = await import("./ui/tooltip-provider.js");
const { __resetForTests } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** jsdom's CSSOM re-serialises a hex colour set via a template literal to
 *  `rgb(r, g, b)` the moment it is read back off `style` — a jsdom behaviour,
 *  not this component's. Compare in the form jsdom will actually hand back. */
function toRgb(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

beforeEach(() => {
  cleanup();
  __resetForTests();
  __resetReplayCacheForTests();
  listeners.clear();
  posts.length = 0;
  resetState();
});
afterEach(() => cleanup());
after(async () => {
  await settle();
  teardown();
});

/** Render, open the disclosure, and settle. */
async function openPanel() {
  render(React.createElement(TooltipProvider, null, React.createElement(CaptionColorsPanel)));
  await settle();
  act(() => {
    screen.getByText("Transcription colors").click();
  });
  await settle();
}

describe("every ProdCom channel is listed", () => {
  test("all of them, even with zero transcript lines", async () => {
    await openPanel();
    for (const c of CHANNELS) {
      assert.ok(screen.queryByText(c.name!), `"${c.name}" is not on the panel`);
    }
  });
});

describe("the follow-ProdCom switch", () => {
  function swatchStyle(label: string): string {
    const btn = screen.getByLabelText(`Color for ${label}`);
    return btn.getAttribute("style") ?? "";
  }

  test("off by default: a non-custom channel shows its distinct auto color, not ProdCom's", async () => {
    await openPanel();
    // Lead TB's ProdCom color is #00f900; the panel must not be showing it while
    // the switch is off.
    assert.ok(!swatchStyle("Lead TB").includes(toRgb("#00f900")));
  });

  test("turning it on changes a non-custom channel's color — on the panel", async () => {
    await openPanel();
    const toggle = screen.getByRole("switch");
    await act(async () => {
      toggle.click();
    });
    await settle();
    assert.ok(
      swatchStyle("Lead TB").includes(toRgb("#00f900")),
      `the panel did not pick up ProdCom's color: ${swatchStyle("Lead TB")}`,
    );
  });

  test("turning it on changes the same channel's color on a caption display", async () => {
    // The shared function (channel-color.test.ts) proves the RULE; this proves
    // the actual display component reacts to the same state the panel does.
    const { TranscriptFeed } = await import("../main/transcript-feed.js");
    const line = { id: "1", channel: "CH-A", channelName: "Lead TB", color: "#00f900", text: "hi", isFinal: true, at: "" };

    const before = render(
      React.createElement(TranscriptFeed, { lines: [line], colorOverrides: {}, followProdcom: false }),
    );
    const colorOff = (before.container.querySelector("p") as HTMLElement).style.color;
    before.unmount();

    const after1 = render(
      React.createElement(TranscriptFeed, { lines: [line], colorOverrides: {}, followProdcom: true }),
    );
    const colorOn = (after1.container.querySelector("p") as HTMLElement).style.color;
    after1.unmount();

    assert.notEqual(colorOn, colorOff, "the display's rendered color did not change with followProdcom");
  });

  test("a custom pick is unaffected by the switch, in either position", async () => {
    state.captionChannelColors = { "Lead TB": "#123456" };
    await openPanel();
    assert.ok(swatchStyle("Lead TB").includes(toRgb("#123456")));

    const toggle = screen.getByRole("switch");
    await act(async () => {
      toggle.click();
    });
    await settle();
    assert.ok(
      swatchStyle("Lead TB").includes(toRgb("#123456")),
      "a custom pick was overridden by the switch",
    );
  });

  test("reset returns a channel to whichever default is active", async () => {
    state.captionChannelColors = { "Lead TB": "#123456" };
    state.followProdcomColors = true;
    await openPanel();
    assert.ok(swatchStyle("Lead TB").includes(toRgb("#123456")));

    const reset = screen.getByLabelText("Reset Lead TB to automatic color");
    await act(async () => {
      reset.click();
    });
    await settle();
    // followProdcomColors is still true, so the active default is ProdCom's own.
    assert.ok(
      swatchStyle("Lead TB").includes(toRgb("#00f900")),
      `reset did not fall through to ProdCom's color: ${swatchStyle("Lead TB")}`,
    );
  });
});
