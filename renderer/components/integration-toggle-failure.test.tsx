// item 4 (findings-t15-r2.md): a failed enable/disable used to toast
// "Failed to enable: Error: <message>" — String(err) on a real Error
// carries its own "Error: " prefix, and the message named no integration at
// all, so two failing cards read identically. Drives the REAL card grid
// against a fake server that fails the one POST, and reads the actual
// rendered toast text — never a unit test of toggleIntegration() in
// isolation, since the bug was in what the operator's screen shows.
//
// The 50 "not wrapped in act" warnings this file used to print were my own
// bug, not an unrelated jsdom quirk (item 4, findings-t15-r3.md, correcting
// the paragraph that used to be here): integrationCard() polled the mount
// for the card BEFORE actIdle() had let the initial `integrations:list`
// query settle — every sibling file (integration-dialog.test.tsx,
// integrations-visibility.test.tsx) calls actIdle() first, then
// integrationCard(); this one had the two calls the wrong way round.
// Swapped, and the file is clean.

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
