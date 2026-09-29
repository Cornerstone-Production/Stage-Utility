// A failed enable or disable names the integration and the server's own
// message — never String(err)'s "Error: " prefix, and never words two
// failing cards would share. Drives the real card grid against a fake
// server that fails the one POST, and reads the rendered toast text: the
// bug was in what the operator's screen shows, not in a helper.
//
// actIdle() comes before integrationCard(), as in integration-dialog.test.tsx:
// the card is looked for only once the initial integrations:list query has
// settled. Looked for first, every update from that query landed outside
// act() and warned.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, fireEvent, screen, waitFor, act } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, integrationCard, actIdle } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { IntegrationsPanel } = await import("./integrations-panel.js");
const { Toaster } = await import("./ui/index.js");

let server = installFakeServer();

beforeEach(() => {
  cleanup();
  server.restore();
});

after(() =>
  unmountAndTeardown(cleanup, () => {
    server.restore();
    teardown();
  }),
);

describe("a failed toggle's toast", () => {
  test("names the integration, and never carries String(err)'s \"Error: \" prefix", async () => {
    server = installFakeServer({}, {}, { id: "video", error: "the relay is not running" });
    const view = render(
      withQueryClient(
        <>
          <IntegrationsPanel />
          <Toaster />
        </>,
      ),
    );
    await actIdle();
    const card = await integrationCard(view.container, "video");
    const sw = card.querySelector<HTMLElement>('[aria-label="Enable Video feeds"]');
    assert.ok(sw, "no enable switch on the video card");
    act(() => {
      fireEvent.click(sw!);
    });

    await waitFor(() => {
      assert.ok(screen.getByText(/Failed to enable Video feeds: the relay is not running/));
    });
    const toastText = document.body.textContent ?? "";
    assert.equal(toastText.includes("Error:"), false, `toast still carries String(err)'s prefix: "${toastText}"`);
  });
});
