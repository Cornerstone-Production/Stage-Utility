// The OpenAI key form over a stubbed server: each state the server can report, and the
// Save, Test and Remove key buttons PRESSED, with the request each sends.
//
// The thing most worth guarding is the key. It goes to the server in one PUT and
// must not stay anywhere in the page afterwards: not in the field, not in the
// query cache, not in the text. A card that draws fine and keeps the secret in a
// cache is how a key ends up in a screenshot.
//
// NOT unit-tested here, driven in a browser instead: the chip and status colours
// in light and dark, and the card's width at 390 px (jsdom loads no stylesheet).

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom, isPlumbing } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { OpenAiKeyForm } = await import("./openai-card.js");

const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
type Conn = { method: "api-key" | null; hint: string | null; state: string; reason: string | null; checkedAt: string | null };
const conn = (over: Partial<Conn> = {}): Conn => ({ method: "api-key", hint: "sk-…3f2a", state: "connected", reason: null, checkedAt: null, ...over });

let current: Conn = conn();
let calls: { method: string; url: string; body: string | null }[] = [];
/** Answers keyed by "METHOD path"; a function sees the body. */
let answers: Record<string, (body: string | null) => { status?: number; body: unknown }> = {};
const realFetch = globalThis.fetch;
let client: InstanceType<typeof QueryClient> | null = null;

beforeEach(() => {
  cleanup();
  current = conn();
  calls = [];
  answers = {};
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if (isPlumbing(url)) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" } as unknown as Response;
    const method = init?.method ?? "GET";
    const body = init?.body ?? null;
    calls.push({ method, url, body });
    const a = answers[`${method} ${url}`];
    const out = a ? a(body) : { body: current };
    const status = out.status ?? 200;
    return { ok: status < 400, status, statusText: "x", json: async () => out.body } as unknown as Response;
  }) as typeof fetch;
});
afterEach(async () => {
  cleanup();
  await settle();
  client?.clear();
});
after(async () => {
  await settle();
  globalThis.fetch = realFetch;
  teardown();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};
async function mount() {
  const r = render(React.createElement(QueryClientProvider, { client: client! }, React.createElement(OpenAiKeyForm)));
  await settle();
  return r;
}
const button = (c: HTMLElement, text: RegExp) => [...c.querySelectorAll("button")].find((b) => text.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
const field = (c: HTMLElement) => c.querySelector("input") as HTMLInputElement;
const type = (c: HTMLElement, v: string) => fireEvent.change(field(c), { target: { value: v } });

describe("the connection, as the server reports it", () => {
  const cases: [string, Partial<Conn>, RegExp][] = [
    ["not-connected", { method: null, hint: null, state: "not-connected" }, /Not connected\./],
    ["unchecked", { state: "unchecked" }, /Key saved\./],
    ["connected", { state: "connected" }, /Connected\./],
    ["invalid-key", { state: "invalid-key" }, /Not connected\./],
    ["out-of-credits", { state: "out-of-credits" }, /Connected, out of credits\./],
    ["forbidden", { state: "forbidden" }, /Image edits refused\./],
    ["unreachable", { state: "unreachable" }, /Could not reach OpenAI\./],
  ];
  for (const [state, over, title] of cases) {
    test(`${state} says so in the chip and the status line`, async () => {
      current = conn(over);
      const { container } = await mount();
      assert.equal(container.querySelector("[data-openai-state]")?.getAttribute("data-openai-state"), state);
      assert.match(container.querySelector("[role=status]:last-child")?.textContent ?? "", title);
    });
  }

  test("the server's own reason is the detail where it has one", async () => {
    current = conn({ state: "invalid-key", reason: "OpenAI rejected the API key" });
    const { container } = await mount();
    assert.match(container.textContent ?? "", /OpenAI rejected the API key/);
  });

  test("the masked hint is the placeholder, and the helper line about Business credits is there", async () => {
    const { container } = await mount();
    assert.equal(field(container).placeholder, "sk-…3f2a (saved)");
    assert.match(container.textContent ?? "", /Uses your ChatGPT Business plan's included API credits/);
    // One line, two links, both opened in a new tab without handing over the opener.
    const links = [...container.querySelectorAll("a")];
    assert.deepEqual(
      links.map((a) => a.getAttribute("href")),
      ["https://developers.openai.com/api/docs/guides/chatgpt-api-credits", "https://platform.openai.com/api-keys"],
    );
    for (const a of links) {
      assert.equal(a.getAttribute("target"), "_blank");
      assert.match(a.getAttribute("rel") ?? "", /noopener/);
    }
    assert.doesNotMatch(container.textContent ?? "", /after that, normal API billing applies/);
  });

  test("there is no ChatGPT sign-in row: it cannot pay for image edits", async () => {
    const { container } = await mount();
    assert.doesNotMatch(container.textContent ?? "", /Sign in with ChatGPT|sign in with ChatGPT/);
  });

  test("with no key saved, Test and Remove key are not offered to press", async () => {
    current = conn({ method: null, hint: null, state: "not-connected" });
    const { container } = await mount();
    assert.equal(button(container, /^Test/)?.disabled, true);
    assert.equal(button(container, /Remove key/), undefined);
    assert.equal(button(container, /^Save/)?.disabled, true, "and Save waits for something typed");
  });
});

describe("Save", () => {
  test("sends the key once, then the field and the page hold none of it", async () => {
    current = conn({ method: null, hint: null, state: "not-connected" });
    answers["PUT /api/openai/key"] = () => ({ body: conn({ state: "unchecked" }) });
    const { container } = await mount();
    type(container, KEY);
    assert.equal(button(container, /^Save/)?.disabled, false);
    await act(async () => void fireEvent.click(button(container, /^Save/)!));
    await settle();
    const put = calls.filter((c) => c.method === "PUT");
    assert.equal(put.length, 1);
    assert.deepEqual(JSON.parse(put[0]!.body!), { apiKey: KEY });
    assert.equal(field(container).value, "", "the field is cleared");
    assert.match(container.textContent ?? "", /Key saved\./);
    assert.ok(!container.innerHTML.includes(KEY), "the key is not in the markup");
    assert.ok(!JSON.stringify(client!.getQueryCache().getAll().map((q) => q.state.data)).includes(KEY), "the key is not in the query cache");
    assert.equal(button(container, /Remove key/) !== undefined, true, "and Remove key now appears");
  });

  test("a refused key says why, keeps what was typed, and does not read as saved", async () => {
    current = conn({ method: null, hint: null, state: "not-connected" });
    answers["PUT /api/openai/key"] = () => ({ status: 400, body: { error: "That does not look like an OpenAI API key" } });
    const { container } = await mount();
    type(container, "short key");
    await act(async () => void fireEvent.click(button(container, /^Save/)!));
    await settle();
    assert.match(container.textContent ?? "", /That does not look like an OpenAI API key/);
    assert.equal(field(container).value, "short key", "the field stays as typed so it can be fixed");
    assert.doesNotMatch(container.textContent ?? "", /Key saved\./);
    assert.match(container.querySelector("[data-openai-state]")?.textContent ?? "", /Not connected/);
  });

  test("Enter in the field saves it", async () => {
    current = conn({ method: null, hint: null, state: "not-connected" });
    const { container } = await mount();
    type(container, KEY);
    await act(async () => void fireEvent.submit(container.querySelector("form")!));
    await settle();
    assert.equal(calls.filter((c) => c.method === "PUT").length, 1);
  });
});

describe("the key and the console", () => {
  test("a key that is saved, and then tested, is written to no console method", async () => {
    current = conn({ method: null, hint: null, state: "not-connected" });
    answers["PUT /api/openai/key"] = () => ({ body: conn({ state: "unchecked" }) });
    answers["POST /api/openai/test"] = () => ({ body: conn({ state: "connected" }) });
    const seen: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const real = Object.fromEntries(methods.map((m) => [m, console[m]]));
    for (const m of methods) console[m] = (...a: unknown[]) => void seen.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    try {
      const { container } = await mount();
      type(container, KEY);
      await act(async () => void fireEvent.click(button(container, /^Save/)!));
      await settle();
      await act(async () => void fireEvent.click(button(container, /^Test/)!));
      await settle();
    } finally {
      for (const m of methods) console[m] = real[m] as never;
    }
    assert.deepEqual(seen.filter((l) => l.includes(KEY)), [], "the key must reach no console line");
  });
});

describe("Test and Remove key", () => {
  test("Test says the key works", async () => {
    answers["POST /api/openai/test"] = () => ({ body: conn({ state: "connected" }) });
    const { container } = await mount();
    await act(async () => void fireEvent.click(button(container, /^Test/)!));
    await settle();
    assert.match(container.textContent ?? "", /Key works\./);
  });

  test("Test says the credits are used up in plain words", async () => {
    answers["POST /api/openai/test"] = () => ({ body: conn({ state: "out-of-credits", reason: "Out of API credits" }) });
    const { container } = await mount();
    await act(async () => void fireEvent.click(button(container, /^Test/)!));
    await settle();
    assert.match(container.textContent ?? "", /Key works, but the credits are used up\./);
    assert.match(container.querySelector("[data-openai-state]")?.textContent ?? "", /out of credits/);
  });

  test("Test says OpenAI rejected an invalid key", async () => {
    answers["POST /api/openai/test"] = () => ({ body: conn({ state: "invalid-key", reason: "OpenAI rejected the API key" }) });
    const { container } = await mount();
    await act(async () => void fireEvent.click(button(container, /^Test/)!));
    await settle();
    assert.match(container.textContent ?? "", /OpenAI rejected this key\./);
  });

  test("Remove key deletes it and goes back to not connected", async () => {
    answers["DELETE /api/openai/key"] = () => ({ body: conn({ method: null, hint: null, state: "not-connected" }) });
    const { container } = await mount();
    await act(async () => void fireEvent.click(button(container, /Remove key/)!));
    await settle();
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
    assert.match(container.querySelector("[data-openai-state]")?.textContent ?? "", /Not connected/);
    assert.equal(button(container, /Remove key/), undefined);
  });

  test("a Test that cannot reach the server says so and leaves the state alone", async () => {
    answers["POST /api/openai/test"] = () => ({ status: 500, body: { error: "boom" } });
    const { container } = await mount();
    await act(async () => void fireEvent.click(button(container, /^Test/)!));
    await settle();
    assert.match(container.textContent ?? "", /boom/);
    assert.equal(container.querySelector("[data-openai-state]")?.getAttribute("data-openai-state"), "connected");
  });
});
