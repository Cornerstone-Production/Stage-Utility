// video-relay-ports.test.tsx — the Advanced page's Video relay ports card:
// prefilled from GET /api/video/state, saved through PATCH /api/video/ports,
// and the rule's error shown inline rather than swallowed.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, fireEvent, screen } = await import("@testing-library/react");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { VideoRelayPortsPanel } = await import("./video-relay-ports.js");

type VideoPorts = import("@main/types/video").VideoPorts;

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});

const PORTS: VideoPorts = { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 };

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

function stubFetch(ports: VideoPorts, opts: { patchError?: string } = {}) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    if (method === "GET" && url.endsWith("/api/video/state")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ rev: 1, relay: { state: "off" }, kinds: [], ports, feeds: [] }),
        text: async () => "",
      } as unknown as Response;
    }
    if (method === "PATCH" && url.endsWith("/api/video/ports")) {
      if (opts.patchError) {
        return { ok: false, status: 400, json: async () => ({ error: opts.patchError }), text: async () => "" } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ports: body }), text: async () => "" } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as unknown as Response;
  }) as typeof fetch;
  return { fn, calls };
}

async function renderPanel(ports: VideoPorts = PORTS, opts: { patchError?: string } = {}) {
  const { fn, calls } = stubFetch(ports, opts);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fn;
  const c = render(<VideoRelayPortsPanel />);
  await settle();
  return { ...c, calls, restore: () => (globalThis.fetch = realFetch) };
}

test("prefills all six ports from the server", async () => {
  const c = await renderPanel();
  try {
    assert.equal(screen.getByRole("textbox", { name: "RTMP" }).getAttribute("value"), "1935");
    assert.equal(screen.getByRole("textbox", { name: "SRT" }).getAttribute("value"), "8890");
    assert.equal(screen.getByRole("textbox", { name: "Video to screens (UDP)" }).getAttribute("value"), "8189");
    assert.equal(screen.getByRole("textbox", { name: "WebRTC signalling" }).getAttribute("value"), "8889");
    assert.equal(screen.getByRole("textbox", { name: "HLS" }).getAttribute("value"), "8888");
    assert.equal(screen.getByRole("textbox", { name: "Relay API" }).getAttribute("value"), "9997");
  } finally {
    c.restore();
  }
});

test("Save PATCHes every field, including the one just edited", async () => {
  const c = await renderPanel();
  try {
    fireEvent.change(screen.getByRole("textbox", { name: "RTMP" }), { target: { value: "21935" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();

    const saved = c.calls.find((call) => call.method === "PATCH" && call.url.endsWith("/api/video/ports"));
    assert.ok(saved, "Save never PATCHed /api/video/ports");
    assert.deepEqual(saved!.body, { ...PORTS, rtmp: 21935 });
    assert.ok(screen.getByText("Saved."));
  } finally {
    c.restore();
  }
});

test("a refused save shows the rule inline, rather than swallowing it", async () => {
  const c = await renderPanel(PORTS, { patchError: "Every port must be different." });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    assert.ok(screen.getByRole("alert"));
    assert.match(screen.getByRole("alert").textContent ?? "", /must be different/);
  } finally {
    c.restore();
  }
});
