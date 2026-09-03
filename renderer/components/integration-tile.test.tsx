// The card, which is a summary and a button and never a form.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
import { INTEGRATION_IDS } from "@main/services/integration-ids.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, settle, idle, blankState, assertAbsent , integrationCard } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { INTEGRATION_DESCRIPTOR_FIXTURE } = await import(
  "../test-fixtures/integration-descriptors.js"
);
const { IntegrationsPanel, integrationFlashId, summaryLine } = await import(
  "./integrations-panel.js"
);

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

async function panel(overrides: Record<string, Partial<IntegrationState>> = {}) {
  server = installFakeServer(overrides);
  const c = render(withQueryClient(<IntegrationsPanel />));
  await idle();
  return c;
}

/** Awaits the card. The synchronous read this replaced could run before React
 *  had committed it — see integrationCard. */
const tile = (c: { container: HTMLElement }, id: string) => integrationCard(c.container, id);

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

describe("the descriptor fixture is the whole list", () => {
  test("it holds exactly the integrations the app ships", () => {
    // INTEGRATION_IDS is the canonical list and a pure data module. Adding an
    // integration fails here rather than quietly rendering fifteen cards in
    // every test in this feature.
    assert.deepEqual(
      INTEGRATION_DESCRIPTOR_FIXTURE.map((d) => d.id).sort(),
      [...INTEGRATION_IDS].sort(),
    );
  });
});

describe("the integration card", () => {
  test("an inbound integration gets no switch", async () => {
    // Companion dials US. A switch here gated nothing: turning it off left the
    // module connecting and controlling the app exactly as before, while the row
    // claimed it was disabled.
    const c = await panel();
    const companion = INTEGRATION_DESCRIPTOR_FIXTURE.find((d) => d.inbound)!;
    assert.equal(companion.id, "companion");
    assertAbsent(
      (await tile(c, "companion")).querySelector('[aria-label="Enable Bitfocus Companion"]'),
      "an inbound integration was given an enable switch",
    );
    // And every outbound one does have one, so the assertion above is not
    // passing because no card has a switch at all.
    assert.ok((await tile(c, "obs")).querySelector('[aria-label="Enable OBS Studio"]'));
  });

  test("clicking the switch flips it without opening the dialog", async () => {
    const c = await panel();
    const sw = (await tile(c, "obs")).querySelector<HTMLElement>('[aria-label="Enable OBS Studio"]')!;
    fireEvent.click(sw);
    await settle();
    assert.equal(server.states.get("obs")?.enabled, true, "the switch did not enable anything");
    assertAbsent(dialog(), "flicking the switch also opened the settings dialog");
  });

  test("clicking the card opens that integration's dialog", async () => {
    const c = await panel();
    fireEvent.click((await tile(c, "reaper")));
    await settle();
    assert.match(dialog()?.textContent ?? "", /REAPER/);
  });

  test("Enter and Space open it too", async () => {
    const c = await panel();
    fireEvent.keyDown((await tile(c, "reaper")), { key: "Enter" });
    await settle();
    assert.ok(dialog(), "Enter did not open the dialog");
    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await settle();

    fireEvent.keyDown((await tile(c, "reaper")), { key: " " });
    await settle();
    assert.ok(dialog(), "Space did not open the dialog");
  });

  test(`all ${INTEGRATION_IDS.length} cards carry the flash id the sender derives`, async () => {
    const c = await panel();
    const seen = new Map(
      [...c.container.querySelectorAll<HTMLElement>("[data-integration-card]")].map((el) => [
        el.getAttribute("data-integration-card")!,
        el.getAttribute("data-flash-id"),
      ]),
    );
    // An exact count, not a floor: the context bar aims a highlight at whichever
    // integration is down, and that is any of them.
    assert.equal(seen.size, INTEGRATION_IDS.length);
    for (const id of INTEGRATION_IDS) {
      assert.equal(seen.get(id), integrationFlashId(id), `${id}'s card carries the wrong flash id`);
    }
  });

  test("every card carries the id the slide animation follows", async () => {
    const c = await panel();
    for (const id of INTEGRATION_IDS) {
      assert.equal((await tile(c, id)).getAttribute("data-slide-id"), id);
    }
  });
});

describe("the card's second line", () => {
  test("shows the machine an integration is pointed at", () => {
    const obs = INTEGRATION_DESCRIPTOR_FIXTURE.find((d) => d.id === "obs")!;
    assert.equal(
      summaryLine(obs, blankState("obs", { config: { host: "192.0.2.50", port: 4455 } })),
      "192.0.2.50:4455",
    );
    assert.equal(
      summaryLine(obs, blankState("obs", { config: { host: "192.0.2.50" } })),
      "192.0.2.50",
    );
  });

  test("falls back to what the integration is, for every one of them", () => {
    // Derived from the descriptor rather than a per-id table, so adding an
    // integration cannot leave a card with a blank line under its name.
    for (const d of INTEGRATION_DESCRIPTOR_FIXTURE) {
      const line = summaryLine(d, blankState(d.id));
      assert.ok(line.length > 0, `${d.id} has no summary line`);
      assert.ok(line.length < 160, `${d.id}'s summary line is a paragraph, not a line`);
    }
  });
});
