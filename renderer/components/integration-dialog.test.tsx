// Every one of this build's dialogs, opened.
//
// The page's whole shape now depends on the dialog: a card holds no form, so an
// integration whose dialog throws or comes up empty has no settings at all. This
// opens every one against the real components and checks the things that
// differ between them — the wide variant, the footer actions, and the inbound
// case that gets neither a switch nor a Save.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();
// React only act-wraps a render, and only warns when an update escapes one,
// once it is told it is in a test environment. Without this the file reads
// as clean while 2097 updates land outside act.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClientAndRouter, assertAbsent, integrationCard, settleFor, actIdle } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { INTEGRATION_DESCRIPTOR_FIXTURE } = await import(
  "../test-fixtures/integration-descriptors.js"
);
const { WIDE_DIALOG_IDS, WIDE_PANEL_ATTR } = await import("./integration-dialog-size.js");
const { IntegrationsPanel } = await import("./integrations-panel.js");

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

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

async function open(id: string) {
  server = installFakeServer();
  const c = render(withQueryClientAndRouter(<IntegrationsPanel />));
  await actIdle();
  fireEvent.click(await integrationCard(c.container, id));
  await settleFor(60);
  const d = dialog();
  assert.ok(d, `the ${id} dialog did not open`);
  return d;
}

const labels = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter(Boolean);

describe("every dialog", () => {
  for (const d of INTEGRATION_DESCRIPTOR_FIXTURE) {
    test(`${d.id} opens with its name and its settings`, async () => {
      const content = await open(d.id);
      assert.match(content.textContent ?? "", new RegExp(d.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      // Whichever way this integration is configured, the body is not empty:
      // either the schema form rendered its fields, or a bespoke panel is there.
      const hasFields = content.querySelectorAll("[data-config-field]").length;
      const hasPanel = content.querySelector(`[${WIDE_PANEL_ATTR}]`) !== null;
      const bodyText = (content.querySelector(".overflow-y-auto")?.textContent ?? "").trim();
      assert.ok(
        hasFields > 0 || hasPanel || bodyText.length > 0,
        `${d.id}'s dialog body is empty — it has no settings at all`,
      );
      if (d.configSchema.length > 0) {
        // Fields can be hidden by showIf (YouTube declares six, shows three), so
        // this is a floor on purpose — the exact count belongs to the descriptor.
        assert.ok(hasFields > 0, `${d.id} declares ${d.configSchema.length} fields and rendered none`);
      }
    });
  }

  test("only the five repeater integrations render a panel that cannot wrap", async () => {
    // The direction integration-dialog-size.test.tsx cannot check on its own: it
    // renders the five panels, this renders every BODY. Between them,
    // neither a missing marker nor a stray one can pass.
    const marked: string[] = [];
    for (const d of INTEGRATION_DESCRIPTOR_FIXTURE) {
      const content = await open(d.id);
      if (content.querySelector(`[${WIDE_PANEL_ATTR}]`)) marked.push(d.id);
      cleanup();
      server.restore();
    }
    assert.deepEqual(marked.sort(), [...WIDE_DIALOG_IDS].sort());
  });
});

describe("the dialog footer", () => {
  // The video card's bespoke panel replaces the form with "Open Video
  // feeds". An <a href> IS the navigation mechanism, so asserting the real,
  // resolved href (not a stub prop, not a button with an onClick) proves a
  // click actually goes to /video-feeds, the same way it would in a browser.
  test("the video card's panel links to /video-feeds, a real anchor href — not a button, not a dead link", async () => {
    const content = await open("video");
    const link = [...content.querySelectorAll<HTMLAnchorElement>("a")].find(
      (a) => a.textContent?.trim() === "Open Video feeds",
    );
    assert.ok(link, "no \"Open Video feeds\" anchor in the video card's panel");
    assert.equal(link!.getAttribute("href"), "/video-feeds");
  });

  test("an inbound integration gets no switch", async () => {
    const content = await open("companion");
    assertAbsent(
      content.querySelector('[aria-label="Enable Bitfocus Companion"]'),
      "the inbound integration's dialog offered an enable switch",
    );
  });

  test("Companion is two cards: its address to copy, and the outbound fields with Test, Browse buttons and Save", async () => {
    // Two halves in one dialog. The first card is the inbound half (what to type
    // into Companion); the second is the outbound half (where this server dials
    // Companion to press buttons). As a bespoke panel the info REPLACED the form,
    // so the host and port the server declared were never on screen, and the
    // fixture's empty schema let the "declares N fields and rendered none" guard
    // above pass over it.
    const content = await open("companion");
    const cards = [...content.querySelectorAll("[data-companion-card]")].map((c) => c.getAttribute("data-companion-card"));
    assert.deepEqual(cards, ["inbound", "outbound"], "Companion is not two cards, inbound then outbound");
    const headings = [...content.querySelectorAll("[data-companion-card] h3")].map((h) => h.textContent);
    assert.deepEqual(headings, ["Companion controls Stage Utility", "Stage Utility presses Companion buttons"]);
    // The fake server never delivers a LAN address, so what the card says in its place is the address's state.
    assert.match(content.querySelector('[data-companion-card="inbound"]')?.textContent ?? "", /Host|LAN address unavailable/, "the address is gone from the first card");
    const fields = [...content.querySelectorAll("[data-config-field]")].map((f) => f.getAttribute("data-config-field"));
    assert.deepEqual(fields, ["host", "port"], "the outbound host and port fields are not rendered");
    for (const f of content.querySelectorAll("[data-config-field]")) {
      assert.ok(f.closest('[data-companion-card="outbound"]'), "a field is outside the outbound card");
    }
    const l = labels(content);
    assert.ok(l.includes("Test"), "no Test for the outbound half");
    assert.ok(l.includes("Browse buttons"), "no Browse buttons");
    assert.ok(l.includes("Save"), "no Save for the outbound half");
    assert.ok(l.includes("Discard"), "no Discard for the outbound half");
    assert.equal(l.includes("Test connection"), false, "Test is in the footer as well as the card");
  });

  test("Companion's Test runs from its card and its answer is read in that card", async () => {
    const content = await open("companion");
    const test = [...content.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Test")!;
    fireEvent.click(test);
    await settleFor(60);
    const shown = content.querySelector('[data-companion-card="outbound"] [data-test-result]');
    assert.ok(shown, "the Test's answer is not in the outbound card");
    assert.equal(shown!.getAttribute("data-test-result"), "ok");
    assert.equal(content.querySelectorAll("[data-test-result]").length, 1, "the answer is drawn in the footer as well as the card");
  });

  test("Companion opens with its saved host, an edit is saved with Save, and the write carries both fields", async () => {
    // The guard the Companion card lacked: that the fields are the saved config, that typing
    // in them is an edit, and that Save sends exactly what is on screen.
    server = installFakeServer({ companion: { config: { host: "10.0.0.5", port: 8000 }, configured: true } });
    const c = render(withQueryClientAndRouter(<IntegrationsPanel />));
    await actIdle();
    fireEvent.click(await integrationCard(c.container, "companion"));
    await settleFor(60);
    const content = dialog()!;
    const host = content.querySelector('[data-config-field="host"] input') as HTMLInputElement;
    assert.equal(host.value, "10.0.0.5", "the saved host is not on screen");
    assert.equal((content.querySelector('[data-config-field="port"] input') as HTMLInputElement).value, "8000");
    const save = () => [...content.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save") as HTMLButtonElement;
    assert.equal(save().disabled, true, "Save is live with nothing edited");
    fireEvent.change(host, { target: { value: "10.0.0.9" } });
    await settleFor(20);
    assert.equal(save().disabled, false, "an edit did not make the card dirty");
    fireEvent.click(save());
    await settleFor(60);
    const wrote = server.posts.filter((p) => p.path === "/api/integrations/companion/config");
    assert.equal(wrote.length, 1);
    assert.deepEqual(wrote[0]!.body, { config: { host: "10.0.0.9", port: 8000 } });
  });

  test("Test waits for Save while the fields hold edits, and says so", async () => {
    // Test reads the SAVED host and port. Beside edited fields it would answer for a Companion
    // the operator is not looking at.
    server = installFakeServer({ companion: { config: { host: "10.0.0.5", port: 8000 }, configured: true } });
    const c = render(withQueryClientAndRouter(<IntegrationsPanel />));
    await actIdle();
    fireEvent.click(await integrationCard(c.container, "companion"));
    await settleFor(60);
    const content = dialog()!;
    const test = () => [...content.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Test") as HTMLButtonElement;
    assert.equal(test().disabled, false);
    assert.equal(content.querySelector("[data-test-needs-save]") === null, true);
    fireEvent.change(content.querySelector('[data-config-field="host"] input')!, { target: { value: "10.0.0.9" } });
    await settleFor(20);
    assert.equal(test().disabled, true, "Test stayed live over unsaved fields");
    assert.match(content.querySelector("[data-test-needs-save]")?.textContent ?? "", /Save first/);
  });

  test("Escape in Companion's page list closes the list, not the dialog behind it", async () => {
    // The list is a popover of its own inside the dialog. Escape pressed in its filter was
    // Radix's too, and closed the whole dialog, over unsaved fields and all.
    server = installFakeServer(
      {},
      {
        "/api/companion/buttons": { ok: true, buttons: [], pages: [{ page: 1, name: "Main", labelled: 2 }, { page: 3, name: "Looks", labelled: 4 }] },
        "/api/companion/pages/1": { ok: true, page: 1, name: "Main", cols: 8, rows: 4, keys: [] },
      },
    );
    const c = render(withQueryClientAndRouter(<IntegrationsPanel />));
    await actIdle();
    fireEvent.click(await integrationCard(c.container, "companion"));
    await settleFor(60);
    const content = dialog()!;
    fireEvent.click([...content.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Browse buttons")!);
    await settleFor(60);
    fireEvent.click(content.querySelector('[aria-label="Companion page"]')!);
    await settleFor(20);
    const filter = content.querySelector('[aria-label="Filter pages"]') as HTMLElement;
    assert.ok(filter, "the page list did not open");
    fireEvent.keyDown(filter, { key: "Escape" });
    await settleFor(60);
    assert.equal(content.querySelector('[aria-label="Filter pages"]') === null, true, "Escape left the list open");
    assert.equal(dialog() !== null, true, "Escape closed the dialog as well as the list");
    // And with the list closed, Escape is the dialog's again.
    fireEvent.keyDown(content.querySelector('[aria-label="Companion page"]')!, { key: "Escape" });
    await settleFor(60);
    assert.equal(dialog() === null, true, "Escape no longer closes the dialog once the list is shut");
  });

  test("Planning Center keeps Refresh now and its synced label", async () => {
    const content = await open("planning-center");
    assert.ok(labels(content).includes("Refresh now"));
    assert.match(content.textContent ?? "", /Never synced|Synced /);
    assert.ok(labels(content).includes("Test connection"));
  });

  test("ProdCom keeps Clear transcript", async () => {
    const content = await open("prodcom");
    assert.ok(labels(content).includes("Clear transcript"));
  });

  test("only Planning Center and ProdCom carry their own action", async () => {
    for (const id of ["obs", "reaper", "smaart"]) {
      const content = await open(id);
      const l = labels(content);
      assert.ok(l.includes("Test connection"), `${id} lost Test connection`);
      assert.equal(l.includes("Refresh now"), false, `${id} grew a Refresh now`);
      assert.equal(l.includes("Clear transcript"), false, `${id} grew a Clear transcript`);
      cleanup();
      server.restore();
    }
  });

  test("a panel that saves its own list gets no Save, Discard or Test", async () => {
    // wireless, osc, rosstalk and scores each save as they are edited and had
    // none of these in the row either. Companion is not in this list: its cards
    // hold a real form, which keeps Save and Discard and has its own Test.
    for (const id of ["wireless", "osc", "rosstalk", "scores"]) {
      const content = await open(id);
      const l = labels(content);
      for (const gone of ["Save", "Discard", "Test connection"]) {
        assert.equal(l.includes(gone), false, `${id}'s dialog grew a "${gone}" it never had`);
      }
      cleanup();
      server.restore();
    }
  });

  test("Save and Discard are dead until something is edited", async () => {
    const content = await open("obs");
    const save = [...content.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!;
    const discard = [...content.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Discard")!;
    assert.equal(save.disabled, true);
    assert.equal(discard.disabled, true);

    fireEvent.change(content.querySelector<HTMLInputElement>('[data-config-field="host"] input')!, {
      target: { value: "192.0.2.31" },
    });
    await settleFor();
    assert.equal(save.disabled, false);
    assert.equal(discard.disabled, false);
  });
});
