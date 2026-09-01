// What the operator types must survive the card moving.
//
// The reported bug: type an IP into an integration at the bottom of the page,
// flick its enable switch, and the card reappears at the top with the field
// EMPTY. Enabling moves the descriptor from the "Not set up" half to the half
// above, a different parent in the React tree, so React unmounted the card and
// mounted a new one — and everything typed lived in the old card's useState.
//
// It was patched with a module-level draft store, a focus-restore effect and a
// preventScroll dance, about eighty lines. The form now lives in a dialog, a
// sibling of the grid in a portal, so the grid can reflow underneath it and the
// form is not remounted at all. This file guards that STRUCTURE: it fails if the
// dialog is ever rendered from inside the tile, which is the only way the bug
// class can come back.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, settle, idle, assertAbsent } = await import(
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

const tile = (c: { container: HTMLElement }, id: string) => {
  const el = c.container.querySelector<HTMLElement>(`[data-integration-card="${id}"]`);
  assert.ok(el, `no card for ${id}`);
  return el;
};

/** The settings dialog, which renders in a portal outside the container. */
const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="dialog"]');

const hostField = (): HTMLInputElement => {
  const el = dialog()?.querySelector<HTMLInputElement>('[data-config-field="host"] input');
  assert.ok(el, "no host field in the dialog");
  return el;
};

describe("a draft survives the card moving between groups", () => {
  test("the typed host is still there after the switch moves the card", async () => {
    // OBS starts dormant: the exact position the bug was reported from.
    server = installFakeServer();
    const c = render(withQueryClient(<IntegrationsPanel />));
    await idle();

    fireEvent.click(tile(c, "obs"));
    await settle();
    fireEvent.change(hostField(), { target: { value: "192.0.2.77" } });
    assert.equal(hostField().value, "192.0.2.77", "the field did not take the value at all");

    // The switch in the DIALOG header — the ordering that used to lose data,
    // because the grid behind reflows while the form is still open.
    const dialogSwitch = dialog()!.querySelector<HTMLElement>('[aria-label="Enable OBS Studio"]');
    assert.ok(dialogSwitch, "no enable switch in the dialog header");
    fireEvent.click(dialogSwitch);
    await settle();

    // The card really did move: it is now in the half above "Not set up".
    assert.equal(server.states.get("obs")?.enabled, true, "the switch did not enable anything");
    const order = [...c.container.querySelectorAll("[data-integration-card]")].map((el) =>
      el.getAttribute("data-integration-card"),
    );
    assert.equal(order[0], "obs", "the card did not move to the in-use half");

    assert.ok(dialog(), "the dialog was unmounted when the card moved");
    assert.equal(
      hostField().value,
      "192.0.2.77",
      "the form came back empty — enabling an integration threw away what was typed",
    );
  });

  test("the dialog is never remounted by the move", async () => {
    // The invariant, stated as identity rather than as form contents: a dialog
    // OWNED by a tile is torn down and rebuilt when that tile moves, and the
    // fields come back from `state` rather than from what was typed. Note that
    // DOM ancestry proves nothing here — Radix portals the content to <body>
    // whichever component rendered it — so this compares the node itself.
    server = installFakeServer();
    const c = render(withQueryClient(<IntegrationsPanel />));
    await idle();
    fireEvent.click(tile(c, "obs"));
    await settle();

    const before = dialog();
    assert.ok(before, "no dialog opened");

    fireEvent.click(dialog()!.querySelector<HTMLElement>('[aria-label="Enable OBS Studio"]')!);
    await settle();

    assert.equal(server.states.get("obs")?.enabled, true, "the switch did not enable anything");
    assert.equal(
      dialog() === before,
      true,
      "the dialog was torn down and rebuilt when the card moved — it is owned by the tile",
    );
  });

  test("nothing survives leaving the page — a draft lives as long as the dialog", async () => {
    // The store this replaced outlived the card on purpose and had to be cleared
    // by hand on unmount. Closing the dialog is the operator walking away from
    // the edit, and a value that reappeared later would be a surprise.
    server = installFakeServer();
    const c = render(withQueryClient(<IntegrationsPanel />));
    await idle();

    fireEvent.click(tile(c, "obs"));
    await settle();
    fireEvent.change(hostField(), { target: { value: "192.0.2.9" } });

    // Discard, then close cleanly, then reopen.
    const discard = [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === "Discard")!;
    fireEvent.click(discard);
    await settle();
    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await settle();
    assertAbsent(dialog(), "the dialog did not close");

    fireEvent.click(tile(c, "obs"));
    await settle();
    assert.equal(hostField().value, "", "a discarded edit came back on the next open");
  });
});
