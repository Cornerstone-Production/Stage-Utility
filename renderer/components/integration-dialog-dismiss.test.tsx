// A dismissed dialog is never consent to throw work away.
//
// Escape, the close button and a click outside all arrive at one handler. With
// unsaved edits it raises the app's UnsavedChangesDialog — Keep editing /
// Discard / Save & close — whose own comment carries the rule. Save stays
// explicit for the reason the screen-URL dialog gives: closing blurs the field,
// so a blur-save races the unmount, and a value the server REFUSED would read as
// accepted because the dialog is already gone.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, settle, blankState } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { INTEGRATION_DESCRIPTOR_FIXTURE } = await import(
  "../test-fixtures/integration-descriptors.js"
);
const { IntegrationDialog } = await import("./integrations-panel.js");

const OBS = INTEGRATION_DESCRIPTOR_FIXTURE.find((d) => d.id === "obs")!;

let server = installFakeServer();

beforeEach(() => {
  cleanup();
  server.restore();
  server = installFakeServer();
});

after(async () => {
  cleanup();
  await settle();
  server.restore();
  teardown();
});

interface Opened {
  closes: number;
  container: HTMLElement;
}

async function openObs(): Promise<Opened> {
  const closed = { n: 0 };
  const c = render(
    withQueryClient(
      <IntegrationDialog
        descriptor={OBS}
        state={blankState("obs")}
        onStateChange={() => {}}
        onClose={() => {
          closed.n += 1;
        }}
      />,
    ),
  );
  await settle();
  return {
    get closes() {
      return closed.n;
    },
    container: c.container,
  };
}

const dialogs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
const settings = (): HTMLElement => {
  const el = dialogs().find((d) => /OBS Studio/.test(d.textContent ?? ""));
  assert.ok(el, "the settings dialog is not on screen");
  return el;
};
const confirmDialog = (): HTMLElement | undefined =>
  dialogs().find((d) => /Unsaved changes/.test(d.textContent ?? ""));

const hostField = (): HTMLInputElement => {
  const el = settings().querySelector<HTMLInputElement>('[data-config-field="host"] input');
  assert.ok(el, "no host field");
  return el;
};

const button = (root: HTMLElement, label: string): HTMLButtonElement => {
  const el = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  assert.ok(el, `no "${label}" button`);
  return el;
};

const type = (value: string) => fireEvent.change(hostField(), { target: { value } });
const escape = () => fireEvent.keyDown(settings(), { key: "Escape" });

describe("dismissing a dialog with unsaved changes", () => {
  test("Escape raises the confirm and does not close", async () => {
    const o = await openObs();
    type("192.0.2.20");
    escape();
    await settle();

    assert.ok(confirmDialog(), "Escape threw the edit away with no question asked");
    assert.equal(o.closes, 0, "the dialog closed anyway");
  });

  test("Keep editing goes back to the form with the edit still in it", async () => {
    const o = await openObs();
    type("192.0.2.20");
    escape();
    await settle();

    fireEvent.click(button(confirmDialog()!, "Keep editing"));
    await settle();

    assert.equal(confirmDialog(), undefined, "the confirm stayed up");
    assert.equal(o.closes, 0);
    assert.equal(hostField().value, "192.0.2.20", "Keep editing lost the edit it was protecting");
  });

  test("Discard closes and writes nothing", async () => {
    const o = await openObs();
    type("192.0.2.20");
    escape();
    await settle();

    fireEvent.click(button(confirmDialog()!, "Discard"));
    await settle();

    assert.equal(o.closes, 1, "Discard did not close the dialog");
    assert.deepEqual(
      server.posts.filter((p) => p.path.endsWith("/config")),
      [],
      "Discard saved the changes it was asked to throw away",
    );
  });

  test("Save & close saves first, then closes", async () => {
    const o = await openObs();
    type("192.0.2.20");
    escape();
    await settle();

    fireEvent.click(button(confirmDialog()!, "Save & close"));
    await settle(60);

    const saves = server.posts.filter((p) => p.path === "/api/integrations/obs/config");
    assert.equal(saves.length, 1, "Save & close did not save");
    assert.equal(
      (saves[0].body as { config: Record<string, unknown> }).config.host,
      "192.0.2.20",
    );
    assert.equal(o.closes, 1, "it saved but never closed");
  });

  test("a clean dialog closes on Escape with no question", async () => {
    const o = await openObs();
    escape();
    await settle();

    assert.equal(confirmDialog(), undefined, "a clean dialog asked about unsaved work");
    assert.equal(o.closes, 1);
  });

  test("the footer's Save is the only thing that writes, and it stays open", async () => {
    // Explicit save, still. Nothing here is autosave: typing writes nothing.
    const o = await openObs();
    type("192.0.2.21");
    await settle();
    assert.deepEqual(server.posts.filter((p) => p.path.endsWith("/config")), []);

    fireEvent.click(button(settings(), "Save"));
    await settle(60);
    assert.equal(server.posts.filter((p) => p.path === "/api/integrations/obs/config").length, 1);
    assert.equal(o.closes, 0, "a footer Save closed the dialog — a refusal would have gone with it");
  });
});
