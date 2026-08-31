// Focus comes back to the card that opened the dialog — including when saving
// moved that card.
//
// Radix returns focus to the NODE it took it from. Enabling an integration moves
// its card from the "Not set up" half to the half above, which unmounts that
// node — so focus landed on <body> and the operator was nowhere, with nothing to
// arrow from. The fix is to remember the integration's ID and look the card up
// fresh once the grid has settled.
//
// NOTHING HERE WAITS A FIXED NUMBER OF MILLISECONDS. Every step waits for the
// condition it actually needs. This file used to bet 30ms on each of them, and
// closing the dialog is not one commit: Radix unmounts the content, the grid
// re-renders, the slide hook runs its FLIP across two animation frames, and only
// then does the effect that restores focus land. Thirty milliseconds covers all
// of that on an idle machine and is a coin toss on a loaded one — this file
// failed once inside a full-suite run and passed in isolation and on every clean
// run after, which is the signature of exactly that. A condition wait has no
// threshold to be on the wrong side of.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, settle, until, idle } = await import(
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

/** Where focus is, in a few words — never the node itself. See the note below. */
const where = (el: Element | null): string => {
  if (!el) return "nothing";
  if (el === document.body) return "<body>";
  const id = el.getAttribute("data-integration-card");
  return id ? `the ${id} card` : `<${el.tagName.toLowerCase()}>`;
};

/** The card, or null. Non-asserting, so it can be used inside a wait. */
const find = (c: { container: HTMLElement }, id: string) =>
  c.container.querySelector<HTMLElement>(`[data-integration-card="${id}"]`);

const card = (c: { container: HTMLElement }, id: string) => {
  const el = find(c, id);
  assert.ok(el, `no card for ${id}`);
  return el;
};
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

/**
 * A loaded page.
 *
 * `idle()`, not "wait for the card to appear". The cards come from the
 * `integrations:list` query, and a wait that only asks whether one card exists
 * can be satisfied before the query has resolved at all — this helper used to do
 * exactly that and left the enable-then-close sequence running against a
 * half-loaded grid. Asking react-query whether it has finished is the honest
 * condition; see the harness.
 */
async function panel() {
  server = installFakeServer();
  const c = render(withQueryClient(<IntegrationsPanel />));
  await idle();
  return c;
}

describe("focus returns to the card", () => {
  test("after a plain open and close", async () => {
    const c = await panel();
    const before = card(c, "reaper");
    before.focus();
    fireEvent.click(before);
    await until(
      () => dialog() !== null,
      () => "clicking the card opened no dialog",
    );

    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await until(
      () => dialog() === null,
      () => "Escape did not close the dialog",
    );
    await until(
      () => document.activeElement === find(c, "reaper"),
      () => `focus did not come back to the card — it is on ${where(document.activeElement)}`,
    );
  });

  test("after enabling it moved the card into the other grid", async () => {
    // The case that used to drop focus on <body>: the node focus was taken from
    // has been unmounted by the time the dialog closes.
    const c = await panel();
    const before = card(c, "reaper");
    before.focus();
    fireEvent.click(before);
    await until(
      () => dialog() !== null,
      () => "clicking the card opened no dialog",
    );

    fireEvent.click(dialog()!.querySelector<HTMLElement>('[aria-label="Enable REAPER"]')!);
    await until(
      () => server.states.get("reaper")?.enabled === true,
      () => "enabling REAPER never reached the server",
    );

    // THE MOVE HAPPENS WHILE THE DIALOG IS STILL OPEN, and this waits for it
    // before pressing Escape. The dialog is rendered beside the grid rather than
    // inside the tile precisely so that it survives its card moving group, so
    // the grid re-sorts under it the moment the save lands.
    //
    // The order matters and is the whole scenario: it is `before` being unmounted
    // BEFORE the dialog closes that made focus land on <body>. Pressing Escape
    // while the save has reached the server but the grid has not yet re-sorted
    // is a different sequence, not a faster version of this one — and one this
    // test has never covered. The old fixed 30ms here was waiting for the move
    // without saying so; this says so.
    await until(
      () => {
        const now = find(c, "reaper");
        return now !== null && now !== before;
      },
      () => "enabling REAPER never moved its card out of the not-set-up grid",
    );

    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await until(
      () => dialog() === null,
      () => "Escape did not close the dialog",
    );
    await until(
      () => document.activeElement === find(c, "reaper"),
      () =>
        `the operator was left with no caret anywhere after the card moved groups — focus is on ${where(document.activeElement)}`,
    );

    // Restated as assertions, so the invariants are written down rather than
    // only implied by what was waited for. Compared as booleans: assert.equal
    // renders a diff of whatever it is given, and inspecting two jsdom elements
    // takes long enough that the file is killed on a timeout instead of
    // reporting the failure.
    const settled = card(c, "reaper");
    assert.equal(before === settled, false, "the card never moved, so nothing was proved");
    assert.equal(
      document.activeElement === settled,
      true,
      "the operator was left with no caret anywhere after the card moved groups",
    );
  });
});
