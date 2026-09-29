// item 4 (findings-t15-r2.md): a failed enable/disable used to toast
// "Failed to enable: Error: <message>" — String(err) on a real Error
// carries its own "Error: " prefix, and the message named no integration at
// all, so two failing cards read identically. Drives the REAL card grid
// against a fake server that fails the one POST, and reads the actual
// rendered toast text — never a unit test of toggleIntegration() in
// isolation, since the bug was in what the operator's screen shows.
//
// NOT clean of "not wrapped in act" warnings, unlike every other file this
// round touched: this is the only test anywhere in the suite that drives an
// ASYNC failure (a rejected fetch) off a click on a full 17-card
// IntegrationsPanel, and the toast/switch state settles across several
// microtask hops testing-library's own act-wrapping does not fully cover —
// confirmed unrelated to this fix (the warnings are identical whether the
// toast reads "Failed to enable Video feeds: …" or the pre-fix "Failed to
// enable: Error: …"). Investigated rather than ignored: wrapping the click
// in `act()` (both sync and async forms) changes nothing, and the file's
// own ~4.6 s runtime traces to the toast module's real 4 s auto-dismiss
// timer outliving the test. The assertion itself is exact and real-DOM, so
// left as the one file with this known noise rather than spending further
// time chasing a warning with no effect on pass/fail.

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
    const card = await integrationCard(view.container, "video");
    await actIdle();
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
