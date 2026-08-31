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
const PROPRESENTER = INTEGRATION_DESCRIPTOR_FIXTURE.find((d) => d.id === "propresenter")!;

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
/** The settings dialog, told apart from the confirm by something only the form
 *  carries — the confirm quotes the integration's label back at you, so a match
 *  on the label alone finds either one. */
const settingsWith = (marker: RegExp): HTMLElement => {
  const el = dialogs().find((d) => marker.test(d.textContent ?? ""));
  assert.ok(el, `the settings dialog is not on screen (looking for ${marker})`);
  return el;
};
const settings = (): HTMLElement => settingsWith(/OBS Studio/);
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

const portField = (): HTMLInputElement => {
  const el = settings().querySelector<HTMLInputElement>('[data-config-field="port"] input');
  assert.ok(el, "no port field");
  return el;
};

/** One of NumberInput's themed steppers on the port field. */
const stepper = (label: "Increase" | "Decrease"): HTMLButtonElement => {
  const el = settings().querySelector<HTMLButtonElement>(
    `[data-config-field="port"] button[aria-label="${label}"]`,
  );
  assert.ok(el, `no ${label} stepper on the port field`);
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

  test("a stepper click and back again leaves nothing to ask about", async () => {
    // The modal must fire for a real edit and nothing else. NumberInput's
    // onChange hands over a NUMBER; storing String(n) made 4455 and "4455"
    // unequal for ever, so one click on the port stepper left Save enabled and
    // put the blocking confirm in front of a config identical to the saved one.
    const o = await openObs();
    fireEvent.click(stepper("Increase"));
    await settle();
    fireEvent.click(stepper("Decrease"));
    await settle();

    assert.equal(portField().value, "4455", "the round trip did not land back on the saved port");
    // The disabled PROPERTY, not a class: a utility layer can restyle a button
    // that is still clickable.
    assert.equal(button(settings(), "Save").disabled, true, "Save stayed armed for an unchanged port");

    escape();
    await settle();
    assert.equal(confirmDialog(), undefined, "the confirm blocked a dismissal with nothing to save");
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

// The rule has to hold for work the dialog does not itself hold.
//
// ProPresenter's extra instances live in ProPresenterInstancesPanel's own
// useState behind a "Save instances" button, and `instances` is not in the
// descriptor's configSchema — so the dialog's form-vs-saved comparison was blind
// to them and Escape closed without asking, unmounting the buffer with the
// dialog. Every suite above drives OBS, which has no sub-panel at all; that is
// exactly why this shipped.

const propSettings = (): HTMLElement => settingsWith(/Additional instances/);

async function openProPresenter(): Promise<Opened> {
  const closed = { n: 0 };
  const c = render(
    withQueryClient(
      <IntegrationDialog
        descriptor={PROPRESENTER}
        state={blankState("propresenter")}
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

/** Add an instance row and name it — the operator's half-finished work. */
async function addInstance(name: string): Promise<void> {
  fireEvent.click(button(propSettings(), "Add instance"));
  await settle();
  const field = propSettings().querySelector<HTMLInputElement>('[aria-label="Instance name"]');
  assert.ok(field, "the new instance row has no name field");
  fireEvent.change(field, { target: { value: name } });
  await settle();
}

const configPosts = () => server.posts.filter((p) => p.path === "/api/integrations/propresenter/config");

const instancesSaved = (): { name?: string }[] => {
  const last = configPosts().at(-1)?.body as { config?: { instances?: { name?: string }[] } } | undefined;
  return last?.config?.instances ?? [];
};

describe("dismissing a dialog whose sub-panel holds unsaved rows", () => {
  test("Escape raises the confirm and does not close", async () => {
    const o = await openProPresenter();
    await addInstance("Chapel");

    fireEvent.keyDown(propSettings(), { key: "Escape" });
    await settle();

    assert.ok(confirmDialog(), "Escape threw the unsaved instance away with no question asked");
    assert.equal(o.closes, 0, "the dialog closed anyway");
  });

  test("a sub-panel with nothing added still closes on Escape with no question", async () => {
    const o = await openProPresenter();

    fireEvent.keyDown(propSettings(), { key: "Escape" });
    await settle();

    assert.equal(confirmDialog(), undefined, "a clean dialog asked about unsaved work");
    assert.equal(o.closes, 1);
  });

  test("Save & close writes the sub-panel's rows, then closes", async () => {
    const o = await openProPresenter();
    await addInstance("Chapel");

    fireEvent.keyDown(propSettings(), { key: "Escape" });
    await settle();
    assert.ok(confirmDialog(), "Escape threw the unsaved instance away with no question asked");
    fireEvent.click(button(confirmDialog()!, "Save & close"));
    await settle(60);

    const rows = instancesSaved();
    assert.equal(rows.length, 1, "Save & close did not write the instance");
    assert.equal(rows[0].name, "Chapel", "it wrote a row, but not the one that was typed");
    assert.equal(o.closes, 1, "it saved but never closed");
  });

  test("Discard closes and writes nothing", async () => {
    const o = await openProPresenter();
    await addInstance("Chapel");

    fireEvent.keyDown(propSettings(), { key: "Escape" });
    await settle();
    assert.ok(confirmDialog(), "Escape threw the unsaved instance away with no question asked");
    fireEvent.click(button(confirmDialog()!, "Discard"));
    await settle(60);

    assert.equal(o.closes, 1, "Discard did not close the dialog");
    assert.deepEqual(
      server.posts.filter((p) => p.path.endsWith("/config")),
      [],
      "Discard saved the rows it was asked to throw away",
    );
  });
});
