// The oauth-device field inside the REAL YouTube dialog — not the row in
// isolation (that is youtube-connect-row.test.tsx), but everything integrations-
// panel.tsx does around it: the connectFieldsUnready gate, and that handleSave's
// mask-skip actually applies to this field type and not just to "password".

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();
// React only act-wraps a render, and only warns when an update escapes one,
// once it is told it is in a test environment. Without this the file reads
// as clean while 244 updates land outside act.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, idle, integrationCard } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { IntegrationsPanel } = await import("./integrations-panel.js");

/** Like settle(), but for a wait that needs a specific real-world duration. */
function settleFor(ms: number): Promise<void> {
  return act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

let server = installFakeServer();

afterEach(() => {
  cleanup();
  server.restore();
});

after(() =>
  unmountAndTeardown(cleanup, () => {
    server.restore();
    teardown();
  }),
);

/** Open YouTube's dialog with the given saved config, and answer the connect
 *  row's own GET as idle — this file is not exercising the connect flow
 *  itself, only what the surrounding card does around the field. */
async function openYoutube(config: Record<string, unknown>): Promise<HTMLElement> {
  server = installFakeServer(
    { youtube: { config, configured: true } },
    { "/api/integrations/youtube/connect": { status: "idle" } },
  );
  const c = render(withQueryClient(<IntegrationsPanel />));
  // act()-wrapped: idle() polls the query cache with a plain setTimeout loop,
  // and sixteen cards' worth of Switch primitives settle their own state
  // while that loop runs, outside any wrapper otherwise. No deadlock risk —
  // idle()'s condition reads react-query's cache, not anything React holds
  // back.
  await act(async () => {
    await idle();
  });
  fireEvent.click(await integrationCard(c.container, "youtube"));
  await settleFor(60);
  const content = document.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(content, "the youtube dialog did not open");
  return content!;
}

const connectButton = (content: HTMLElement) =>
  [...content.querySelectorAll("button")].find((b) => b.textContent?.includes("Connect YouTube"));

describe("the oauth-device field in the real dialog", () => {
  test("renders the connect row rather than a bare password field", async () => {
    const content = await openYoutube({ mode: "oauth", clientId: "saved-id", clientSecret: "••••" });
    await settleFor(30);
    assert.match(content.textContent ?? "", /Not connected|Connect YouTube/);
    assert.equal(
      content.querySelector('[data-config-field="refreshToken"] input[type="password"]'),
      null,
      "the paste disclosure must start closed, so no password input yet",
    );
  });

  test("Connect is disabled when the client id and secret were never saved", async () => {
    const content = await openYoutube({ mode: "oauth", clientId: "", clientSecret: "" });
    await settleFor(30);
    assert.equal(connectButton(content)?.disabled, true);
    assert.match(content.textContent ?? "", /Save the client ID and secret first/);
  });

  test("Connect is enabled once the client id and secret are saved and untouched", async () => {
    const content = await openYoutube({ mode: "oauth", clientId: "saved-id", clientSecret: "••••" });
    await settleFor(30);
    assert.equal(connectButton(content)?.disabled, false);
  });

  test("Connect goes back to disabled the moment the client secret is edited, before Save", async () => {
    const content = await openYoutube({ mode: "oauth", clientId: "saved-id", clientSecret: "••••" });
    await settleFor(30);
    assert.equal(connectButton(content)?.disabled, false, "sanity: starts enabled");

    const secretInput = content.querySelector<HTMLInputElement>('[data-config-field="clientSecret"] input')!;
    fireEvent.change(secretInput, { target: { value: "a-new-secret-being-typed" } });
    await settle();

    assert.equal(connectButton(content)?.disabled, true, "an unsaved edit must gate Connect off again");
  });
});

describe("saving the card does not resubmit the connect row's mask", () => {
  test("an unrelated field save omits refreshToken while it still shows the mask", async () => {
    const content = await openYoutube({
      mode: "oauth",
      clientId: "saved-id",
      clientSecret: "••••",
      refreshToken: "••••",
      channelTitle: "Grace Church",
    });
    await settleFor(30);

    const clientIdInput = content.querySelector<HTMLInputElement>('[data-config-field="clientId"] input')!;
    fireEvent.change(clientIdInput, { target: { value: "saved-id-2" } });
    await settle();

    const saveButton = [...content.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!;
    fireEvent.click(saveButton);
    await settleFor(60);

    const post = server.posts.find((p) => p.path === "/api/integrations/youtube/config");
    assert.ok(post, "no save reached the server");
    const body = (post!.body as { config: Record<string, unknown> }).config;
    assert.equal("refreshToken" in body, false, "an unedited masked refreshToken must not be resubmitted");
  });
});
