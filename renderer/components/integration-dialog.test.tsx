// Every one of the sixteen dialogs, opened.
//
// The page's whole shape now depends on the dialog: a card holds no form, so an
// integration whose dialog throws or comes up empty has no settings at all. This
// opens all sixteen against the real components and checks the things that
// differ between them — the wide variant, the footer actions, and the inbound
// case that gets neither a switch nor a Save.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, settle, idle, assertAbsent, integrationCard } = await import(
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

after(async () => {
  cleanup();
  await settle();
  server.restore();
  teardown();
});

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

async function open(id: string) {
  server = installFakeServer();
  const c = render(withQueryClient(<IntegrationsPanel />));
  await idle();
  fireEvent.click(await integrationCard(c.container, id));
  await settle(60);
  const d = dialog();
  assert.ok(d, `the ${id} dialog did not open`);
  return d;
}

const labels = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter(Boolean);

describe("all sixteen dialogs", () => {
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
    // renders the five panels, this renders all sixteen BODIES. Between them,
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
  test("an inbound integration gets no switch and no Save", async () => {
    const content = await open("companion");
    assertAbsent(
      content.querySelector('[aria-label="Enable Bitfocus Companion"]'),
      "the inbound integration's dialog offered an enable switch",
    );
    assert.deepEqual(labels(content).filter((l) => l === "Save" || l === "Discard"), []);
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
    // wireless, osc, rosstalk, scores and companion each save as they are edited
    // and had none of these in the row either.
    for (const id of ["wireless", "osc", "rosstalk", "scores", "companion"]) {
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
    await settle();
    assert.equal(save.disabled, false);
    assert.equal(discard.disabled, false);
  });
});
