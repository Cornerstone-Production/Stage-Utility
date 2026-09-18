// YouTubeConnectRow's four states, the disabled hint, and the poll that must
// start on "pending" and stop on anything else.
//
// `fetch` is stubbed directly rather than through installFakeServer — this
// component talks to exactly three routes and the assertions are about STATE
// TRANSITIONS a mounted control drives itself into, which is the "drive it,
// don't just render it" rule: a button that renders is not a button that does
// anything.
//
// NOT TESTED HERE: the monospace code's size, the countdown's tick cadence
// against a wall clock, and the disclosure's open/close animation — CSS and
// timing jsdom cannot see. Driven in a headless browser instead alongside the
// panel's own layout checks.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { YouTubeConnectRow } = await import("./youtube-connect-row.js");

type Handler = (method: string, body: unknown) => unknown;

const realFetch = globalThis.fetch;
let handler: Handler = () => ({ status: "idle" });
let calls: { method: string; body: unknown }[] = [];

function installFetch(h: Handler): void {
  handler = h;
  globalThis.fetch = (async (_input: unknown, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, body });
    const value = handler(method, body);
    return { ok: true, status: 200, statusText: "OK", json: async () => value } as unknown as Response;
  }) as typeof fetch;
}

after(() => teardown());
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  calls = [];
});

/** Mount the row, under a fresh query client with retries off, and let its
 *  initial GET settle. */
async function mount(props: Partial<React.ComponentProps<typeof YouTubeConnectRow>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const result = render(
    <QueryClientProvider client={client}>
      <YouTubeConnectRow
        disabled={false}
        disabledHint="Save the client ID and secret first"
        rawValue=""
        onRawChange={() => {}}
        pollMs={10}
        {...props}
      />
    </QueryClientProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
  return result;
}

describe("the four states", () => {
  test("idle, enabled: Connect YouTube and 'Not connected'", async () => {
    installFetch(() => ({ status: "idle" }));
    const { container } = await mount();
    assert.match(container.textContent ?? "", /Not connected/);
    const button = container.querySelector("button");
    assert.match(button?.textContent ?? "", /Connect YouTube/);
    assert.equal(button?.disabled, false);
  });

  test("idle, disabled: the hint shows and the button cannot be pressed", async () => {
    installFetch(() => ({ status: "idle" }));
    const { container } = await mount({ disabled: true });
    assert.match(container.textContent ?? "", /Save the client ID and secret first/);
    const button = [...container.querySelectorAll("button")].find((b) => /Connect YouTube/.test(b.textContent ?? ""));
    assert.equal(button?.disabled, true);
  });

  test("pending: the code, the instruction, and a Cancel control", async () => {
    installFetch(() => ({
      status: "pending",
      userCode: "GQVQ-SHNC",
      verificationUrl: "https://www.google.com/device",
      expiresAt: Date.now() + 30 * 60_000,
    }));
    const { container } = await mount();
    const text = container.textContent ?? "";
    assert.match(text, /GQVQ-SHNC/);
    assert.match(text, /google\.com\/device/);
    assert.match(text, /Cancel/);
  });

  test("connected: the channel title and Reconnect / Disconnect", async () => {
    installFetch(() => ({ status: "connected", channelTitle: "Grace Church" }));
    const { container } = await mount();
    const text = container.textContent ?? "";
    assert.match(text, /Connected/);
    assert.match(text, /Grace Church/);
    assert.match(text, /Reconnect/);
    assert.match(text, /Disconnect/);
  });

  test("error: the server's sentence and Try again", async () => {
    installFetch(() => ({ status: "error", message: "You declined the request in Google" }));
    const { container } = await mount();
    const text = container.textContent ?? "";
    assert.match(text, /You declined the request in Google/);
    assert.match(text, /Try again/);
  });
});

describe("polling", () => {
  test("starts once pending and keeps asking the status route", async () => {
    installFetch(() => ({
      status: "pending",
      userCode: "GQVQ-SHNC",
      verificationUrl: "https://www.google.com/device",
      expiresAt: Date.now() + 30 * 60_000,
    }));
    await mount({ pollMs: 10 });
    const afterMount = calls.length;
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(calls.length > afterMount, "no further GET was made while pending");
  });

  test("stops once connected, even if a stray timer is already queued", async () => {
    let n = 0;
    installFetch(() => {
      n++;
      // pending on the first read, connected from the second read onward — the
      // shape of an attempt finishing between two polls.
      return n === 1
        ? { status: "pending", userCode: "GQVQ-SHNC", verificationUrl: "https://www.google.com/device", expiresAt: Date.now() + 30 * 60_000 }
        : { status: "connected", channelTitle: "Grace Church" };
    });
    await mount({ pollMs: 10 });
    // Let it poll past the point where it should have flipped to connected.
    await new Promise((r) => setTimeout(r, 80));
    const countWhenConnected = calls.length;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.length, countWhenConnected, "polling continued after the row reported connected");
  });
});
