// Two things inside the dialog that are the kind that break silently.
//
// - ScoresTeamsPanel's TeamPicker is a Radix Popover INSIDE a Radix Dialog. A
//   popover that is not recognised as nested counts as "outside", so the click
//   that opens it — or any click within it — dismisses the dialog underneath.
// - SenSourceScopePicker puts a max-h-48 scroll inside the dialog body's own
//   scroll. Losing its bound would stretch the dialog instead of scrolling.
//
// Both work; both are worth a guard rather than a redesign.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, settle, idle, until } = await import(
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

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

async function open(
  id: string,
  overrides: Record<string, Partial<IntegrationState>> = {},
  routes: Record<string, unknown> = {},
) {
  server = installFakeServer(overrides, routes);
  const c = render(withQueryClient(<IntegrationsPanel />));
  await idle();
  fireEvent.click(c.container.querySelector<HTMLElement>(`[data-integration-card="${id}"]`)!);
  await until(
    () => dialog() !== null,
    () => `the ${id} dialog did not open`,
  );
  return c;
}

describe("a popover inside the dialog", () => {
  test("the team picker opens and the dialog underneath stays up", async () => {
    await open("scores");

    const trigger = [...dialog()!.querySelectorAll("button")].find(
      (b) => b.textContent?.includes("Add a team"),
    );
    assert.ok(trigger, "no team picker trigger in the scores dialog");

    fireEvent.click(trigger);
    // Radix Popover opens on pointerdown; jsdom's click does not synthesise one.
    fireEvent.pointerDown(trigger);
    fireEvent.pointerUp(trigger);
    await settle(60);

    const popover = document.querySelector('[data-radix-popper-content-wrapper]');
    assert.ok(popover, "the team picker did not open inside the dialog");
    assert.ok(dialog(), "opening the team picker dismissed the dialog underneath it");

    // And a click INSIDE the popover is not "outside" the dialog.
    fireEvent.pointerDown(popover);
    fireEvent.click(popover);
    await settle(60);
    assert.ok(dialog(), "a click inside the team picker dismissed the dialog underneath it");
  });
});

describe("a scroll inside the dialog's scroll", () => {
  test("the SenSource zone list keeps its own bound", async () => {
    // Configured, so the picker loads its lists on mount and actually renders
    // the box rather than its "load zones" prompt.
    await open(
      "sensource",
      { sensource: { configured: true } },
      {
        "/api/sensource/zones": Array.from({ length: 12 }, (_, i) => ({
          zoneId: `zone-${i}`,
          name: `Zone ${i}`,
          locationId: null,
        })),
      },
    );
    await settle(60);

    const body = dialog()!.querySelector<HTMLElement>(".overflow-y-auto");
    assert.ok(body, "the dialog body does not scroll");

    // WHAT THIS IS AND IS NOT.
    //
    // It reads a CLASS NAME, so it is a check on the source shape, not on the
    // layout: it goes red if the bound is deleted, and stays green if a later
    // `@layer utilities` rule overrides max-h-48 — which is this repo's named
    // scar, recorded a few lines from the code under test
    // (integrations-visibility.test.tsx's su-card assertion says the same).
    // jsdom runs no cascade and lays nothing out, so a real bound cannot be
    // measured here; what CAN be pinned is that the intent is still written
    // down, and it is asserted at that altitude deliberately.
    const list = [...dialog()!.querySelectorAll<HTMLElement>("div")].find((el) =>
      el.className.includes("max-h-48"),
    );
    assert.ok(
      list,
      "the zone list lost its bound, so a long list would stretch the dialog instead of scrolling",
    );
    assert.match(list.className, /overflow-y-auto/);
    assert.equal(list.closest(".overflow-y-auto") === list, true);
    // It really is a list of zones, not an empty box that happens to be bounded.
    assert.equal(list.querySelectorAll("button").length, 12);
  });
});
