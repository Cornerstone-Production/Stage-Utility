// The centred confirm: one dialog, one store. confirm() answers the button;
// confirmWith() answers the button AND the checkbox a dialog may carry.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent, act, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ConfirmHost, confirm, confirmWith } = await import("./confirm-dialog.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(() => {
  cleanup();
  teardown();
});
afterEach(async () => {
  // A dialog left open by a failing test must not answer the next one.
  cleanup();
  await settle();
});

async function mount() {
  render(React.createElement(ConfirmHost));
  await act(async () => { await settle(); });
}
/** Open a dialog inside act, as a click handler would. */
async function ask<T>(open: () => Promise<T>): Promise<{ answer: Promise<T> }> {
  let pending!: Promise<T>;
  await act(async () => { pending = open(); await settle(); });
  // Boxed: returning the promise itself from an async function would wait for it.
  return { answer: pending };
}
const press = async (name: string) => {
  const dialog = await screen.findByRole("alertdialog");
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name })); await settle(); });
};

describe("confirm", () => {
  test("a plain confirm resolves true on the button and false on Cancel", async () => {
    await mount();
    const yes = await ask(() => confirm({ title: "Go?", confirmLabel: "Go" }));
    await press("Go");
    assert.equal(await yes.answer, true);
    const no = await ask(() => confirm({ title: "Go?", confirmLabel: "Go" }));
    await press("Cancel");
    assert.equal(await no.answer, false);
  });

  test("a note is drawn under the message", async () => {
    await mount();
    const p = await ask(() => confirm({ title: "Delete?", message: "Its layout goes with it.", note: '"Booth" will show nothing.' }));
    const dialog = await screen.findByRole("alertdialog");
    assert.ok(within(dialog).getByText('"Booth" will show nothing.'));
    await press("Confirm");
    await p.answer;
  });
});

describe("confirmWith a checkbox", () => {
  const ASK = {
    title: 'Remove "Booth"?',
    confirmLabel: "Remove screen",
    checkbox: { label: 'Also delete its view, "Booth"', confirmLabel: "Remove screen and view" },
  };

  test("starts unticked, and the answer says so", async () => {
    await mount();
    const p = await ask(() => confirmWith(ASK));
    const dialog = await screen.findByRole("alertdialog");
    assert.equal(within(dialog).getByRole("checkbox").getAttribute("aria-checked"), "false");
    await press("Remove screen");
    assert.deepEqual(await p.answer, { ok: true, checked: false });
  });

  test("ticking it changes the button and is part of the answer", async () => {
    await mount();
    const p = await ask(() => confirmWith(ASK));
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("checkbox")); await settle(); });
    assert.ok(within(dialog).getByRole("button", { name: "Remove screen and view" }));
    await press("Remove screen and view");
    assert.deepEqual(await p.answer, { ok: true, checked: true });
  });

  test("cancelling after ticking answers neither", async () => {
    await mount();
    const p = await ask(() => confirmWith(ASK));
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("checkbox")); await settle(); });
    await press("Cancel");
    assert.deepEqual(await p.answer, { ok: false, checked: false });
  });

  test("the next dialog starts from its own default, not the last answer", async () => {
    await mount();
    const first = await ask(() => confirmWith(ASK));
    let dialog = await screen.findByRole("alertdialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("checkbox")); await settle(); });
    await press("Remove screen and view");
    await first.answer;
    await act(async () => { await settle(); await settle(); });
    const second = await ask(() => confirmWith(ASK));
    dialog = await screen.findByRole("alertdialog");
    assert.equal(within(dialog).getByRole("checkbox").getAttribute("aria-checked"), "false");
    await press("Remove screen");
    assert.deepEqual(await second.answer, { ok: true, checked: false });
  });
});
