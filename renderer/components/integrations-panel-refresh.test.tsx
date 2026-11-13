// Planning Center's Refresh now, when the server answers that it could not
// refresh: the failure reaches the operator as an error toast with the server's
// words, never "Plan refreshed from PCO." A refresh during a plan hold is that
// case: the server holds the followed plan while its service type cannot be read,
// and says so instead of answering 200.
//
// Driven through the real Integrations page over the fake server.

import { strict as assert } from "node:assert";
import { after, mock, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClientAndRouter, integrationCard, settleFor, actIdle } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { IntegrationsPanel } = await import("./integrations-panel.js");
const { toast } = await import("./ui/index.js");

const HELD = "holding the followed plan: Sunday could not be read — Planning Center returned 503";

let server = installFakeServer();
after(() =>
  unmountAndTeardown(cleanup, () => {
    server.restore();
    teardown();
  }),
);

test("a refresh the server refuses shows its reason, not a success", async () => {
  server.restore();
  server = installFakeServer({ "planning-center": { enabled: true, configured: true } });
  const fake = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    if (String(input) === "/api/refresh" && init?.method === "POST") {
      return { ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({ error: HELD }) } as unknown as Response;
    }
    return fake(input as string, init as RequestInit);
  }) as typeof fetch;
  const errors: string[] = [];
  const successes: string[] = [];
  mock.method(toast, "error", (m: string) => {
    errors.push(m);
  });
  mock.method(toast, "success", (m: string) => {
    successes.push(m);
  });
  try {
    const c = render(withQueryClientAndRouter(<IntegrationsPanel />));
    await actIdle();
    fireEvent.click(await integrationCard(c.container, "planning-center"));
    await settleFor(60);
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Refresh now");
    assert.ok(button, "the Planning Center dialog has no Refresh now");
    fireEvent.click(button!);
    await settleFor(60);
    assert.deepEqual(successes, [], "a refused refresh was reported as a success");
    assert.deepEqual(errors, [`Refresh failed: ${HELD}`]);
  } finally {
    mock.restoreAll();
    globalThis.fetch = fake;
  }
});
