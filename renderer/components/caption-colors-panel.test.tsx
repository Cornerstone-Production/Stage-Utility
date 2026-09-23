// The Transcription colors panel lists every ProdCom channel, whether or not it
// has spoken.
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
 *  a real broadcast be delivered the way the server would. */
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

const CHANNELS: ProdcomChannelDTO[] = [
  { id: "CH-A", name: "Lead TB", color: "#00f900" },
  { id: "CH-B", name: "FOH TB", color: "#ff2600" },
  { id: "CH-C", name: "Cues", color: "#9437ff" },
];

let state: { captionChannelColors: Record<string, string> };
function resetState(): void {
  state = { captionChannelColors: {} };
}

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
  return json({ ok: true });
};

const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { CaptionColorsPanel } = await import("./caption-colors-panel.js");
const { TooltipProvider } = await import("./ui/tooltip-provider.js");
const { __resetForTests } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  cleanup();
  __resetForTests();
  __resetReplayCacheForTests();
  listeners.clear();
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
    // Today's bug, at production scale: the panel used to list only channels
    // seen in the transcript window plus saved ones, so a 17-channel box
    // showed 8. The fake box here answers with 0 transcript lines and 3
    // channels, none of which have "spoken" — the panel must show all 3 anyway.
    await openPanel();
    for (const c of CHANNELS) {
      assert.ok(screen.queryByText(c.name!), `"${c.name}" is not on the panel`);
    }
  });
});
