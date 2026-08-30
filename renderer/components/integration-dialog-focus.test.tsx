// Focus comes back to the card that opened the dialog — including when saving
// moved that card.
//
// Radix returns focus to the NODE it took it from. Enabling an integration moves
// its card from the "Not set up" half to the half above, which unmounts that
// node — so focus landed on <body> and the operator was nowhere, with nothing to
// arrow from. The fix is to remember the integration's ID and look the card up
// fresh once the grid has settled.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, settle } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { IntegrationsPanel } = await import("./integrations-panel.js");

let server = installFakeServer();

beforeEach(() => {
  cleanup();
  server.restore();
});

after(async () => {
  cleanup();
  await settle();
  server.restore();
  teardown();
});

const card = (c: { container: HTMLElement }, id: string) => {
  const el = c.container.querySelector<HTMLElement>(`[data-integration-card="${id}"]`);
  assert.ok(el, `no card for ${id}`);
  return el;
};
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

async function panel() {
  server = installFakeServer();
  const c = render(withQueryClient(<IntegrationsPanel />));
  await settle();
  return c;
}

describe("focus returns to the card", () => {
  test("after a plain open and close", async () => {
    const c = await panel();
    const before = card(c, "reaper");
    before.focus();
    fireEvent.click(before);
    await settle();

    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await settle();

    assert.equal(
      document.activeElement === card(c, "reaper"),
      true,
      "focus did not come back to the card",
    );
  });

  test("after enabling it moved the card into the other grid", async () => {
    // The case that used to drop focus on <body>: the node focus was taken from
    // has been unmounted by the time the dialog closes.
    const c = await panel();
    const before = card(c, "reaper");
    before.focus();
    fireEvent.click(before);
    await settle();

    fireEvent.click(dialog()!.querySelector<HTMLElement>('[aria-label="Enable REAPER"]')!);
    await settle();
    assert.equal(server.states.get("reaper")?.enabled, true);

    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await settle();

    const after = card(c, "reaper");
    // The card really is a different node — the move happened, so this is the
    // case the guard is for and not a re-render that changed nothing.
    assert.equal(before === after, false, "the card never moved, so nothing was proved");
    // Compared as a boolean: assert.equal renders a diff of whatever it is
    // given, and inspecting two jsdom elements takes long enough that the file
    // is killed on a timeout instead of reporting the failure.
    assert.equal(
      document.activeElement === after,
      true,
      "the operator was left with no caret anywhere after the card moved groups",
    );
  });
});
