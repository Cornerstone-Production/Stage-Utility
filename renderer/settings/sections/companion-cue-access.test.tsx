// A copy says whether it copied.
//
// The minted access token is shown once: "it is not stored and cannot be shown
// again". On plain HTTP the clipboard falls to execCommand, and execCommand can
// fail (focus moved, or the browser refused). The card toasted "Copied" without
// reading the result, so the operator pressed Done and lost a token that was
// never on their clipboard. Driven against the real card, the real Toaster and a
// copy that fails.
//
// NOT unit-tested here: the token stays selectable in full by hand (the <code>
// truncates by CSS, and jsdom loads no stylesheet), checked in a browser.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installDom();

let logged: { tag: string; message: string }[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
  const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });
  if (url === "/api/log/client") {
    logged.push(JSON.parse(String(init?.body)));
    return json({ ok: true });
  }
  if (url === "/api/cues/tokens" && init?.method === "POST") return json({ secret: "tok_secret_1234", id: "t1" });
  if (url === "/api/cues/tokens") return json({ tokens: [] });
  if (url === "/api/cues/home-assistant.yaml") return json({});
  throw new Error(`unexpected request ${url}`);
};
class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 1;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { Toaster } = await import("../../components/ui/toast.js");
const { CueAccessCard } = await import("./companion-cues.js");
const { withQueryClient, actUntil } = await import("../../test-fixtures/integrations-harness.js");

const text = () => document.body.textContent ?? "";

beforeEach(() => {
  logged = [];
  Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
  delete (navigator as { clipboard?: unknown }).clipboard;
});
afterEach(async () => {
  cleanup();
  await settle();
});
after(() => unmountAndTeardown(cleanup, teardown));

async function mintAndCopy(copySucceeds: boolean): Promise<void> {
  document.execCommand = () => copySucceeds;
  render(withQueryClient(React.createElement(React.Fragment, null, React.createElement(Toaster), React.createElement(CueAccessCard))));
  const input = document.querySelector("input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Home Assistant" } });
  await act(async () => {
    fireEvent.click([...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Mint")) as HTMLElement);
  });
  await actUntil(() => text().includes("tok_secret_1234"), () => "the minted token never appeared");
  const copy = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Copy") as HTMLElement;
  await act(async () => {
    fireEvent.click(copy);
  });
}

describe("copying the minted token", () => {
  test("a copy that did not copy says so, and the token stays on screen", async () => {
    await mintAndCopy(false);
    await actUntil(() => /could not copy/i.test(text()), () => "a failed copy never told the operator");

    assert.equal(/Copied/.test(text()), false, "said Copied for a copy that did not happen");
    assert.ok(text().includes("tok_secret_1234"), "the one-time token left the screen after a failed copy");
    assert.ok(
      logged.some((l) => l.tag === "companion" && /could not copy/.test(l.message)),
      "the failed copy never reached /log",
    );
    assert.equal(
      logged.some((l) => l.message.includes("tok_secret_1234")),
      false,
      "the minted token was written to the log",
    );
  });

  test("a copy that worked says Copied and logs nothing", async () => {
    await mintAndCopy(true);
    await actUntil(() => /Copied/.test(text()), () => "a good copy never said so");
    assert.deepEqual(logged, []);
  });
});
