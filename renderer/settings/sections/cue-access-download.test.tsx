// The Download YAML button on the Calling cues card.
//
// Copy YAML writes to the clipboard, which is a secure-context browser API and
// fails on the plain-HTTP LAN address every real install answers on (see
// prod-insecure-context notes). Download YAML is a plain anchor instead, so
// what matters here is entirely in two attribute strings: the href it points
// at, and that `download` is set at all — jsdom cannot tell us whether the
// click actually saves a file, but it can tell us the anchor is wired to do
// so, which is the part a component that "renders but does nothing" gets
// wrong.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — see cue-pair-state.test.tsx.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  if (url.includes("/api/events/subscribe")) {
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  }
  if (url.includes("cues:tokens") || url.includes("/api/cues/tokens")) {
    const body = { tokens: [] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CueAccessCard } = await import("./companion-cues.js");

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

let client: InstanceType<typeof QueryClient> | null = null;

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    React.createElement(QueryClientProvider, { client }, React.createElement(CueAccessCard)),
  );
  await settle();
  return view;
}

afterEach(async () => {
  cleanup();
  client?.clear();
  await settle();
});
after(async () => {
  cleanup();
  await settle();
  teardown();
});

describe("the Download YAML control", () => {
  test("is a plain anchor to the Home Assistant route, with download set", async () => {
    await mount();
    // The card is a Collapsible, closed by default — open it the way an
    // operator would, by clicking the header.
    await act(async () => {
      fireEvent.click(screen.getByText("Calling cues"));
    });
    await settle();
    const anchor = [...document.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === "/api/cues/home-assistant.yaml",
    );
    assert.ok(anchor, "no anchor points at /api/cues/home-assistant.yaml");
    assert.equal(anchor!.getAttribute("download"), "", "the anchor is missing the download attribute");
    assert.equal(anchor!.textContent?.includes("Download YAML"), true);
  });
});
