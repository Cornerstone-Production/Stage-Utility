// Home's Presses sheet, through the real component and the same Presses control the
// layout inspector uses, against the in-memory server both tests share.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - THE TILE'S OWN COMMAND BELONGS TO HOME, UNDER THE TILE'S OWN ID. An owner of
//    some other view would leave the rule an orphan the first time Home is saved, and
//    the same id on two tiles would have one tile rewrite the other's command.
//  - SAVE STORES THE LABEL AND THE CHOICE, AND CANCEL STORES NOTHING. A sheet that
//    wrote on every pick would change a tile the operator then backed out of.
//
// NOT unit-tested here, because jsdom cannot see it: how the sheet looks and where
// it sits. Driven in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import type { LayoutObject } from "@main/types/views.js";
import { eventually, installDom, unmountAndTeardown } from "../../test-dom.js";
import { serve as serveButtons } from "../../test-fixtures/button-server.js";
import { NoStream } from "../../test-fixtures/no-stream.js";

const teardown = installDom();
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup, fireEvent, screen } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ButtonPressSheet } = await import("./button-press-sheet.js");
const { timing } = await import("../../editor/action-pane.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());
beforeEach(() => {
  timing.fieldWriteMs = 0;
});

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

const card = (config: Record<string, unknown> = { type: "cue-button", cue: "", showDevice: true }): LayoutObject =>
  ({ id: "home-cue-button-5-4", x: 0, y: 0, w: 1, h: 1, z: 0, home: { size: "s" }, config }) as unknown as LayoutObject;

function mount(c: LayoutObject, serveOpts: Parameters<typeof serveButtons>[0] = {}) {
  const server = serveButtons(serveOpts);
  restores.push(server.restore);
  const saved: LayoutObject[] = [];
  let closed = 0;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider as never,
      { client: qc },
      React.createElement(ButtonPressSheet as never, {
        card: c,
        onSave: (next: LayoutObject) => saved.push(next),
        onClose: () => closed++,
      }),
    ),
  );
  return { server, saved, closes: () => closed };
}

const choice = (name: string) => {
  const b = [...document.querySelectorAll('[aria-label="Presses"] button')].find((x) => x.textContent === name);
  assert.ok(b, `no "${name}" choice`);
  return b as HTMLElement;
};

describe("the Presses sheet", () => {
  test("asks what the tile presses: a Label and the three choices", () => {
    mount(card());
    assert.ok(screen.getByText("What this tile presses"));
    assert.ok(document.querySelector('input[aria-label="Label"]'));
    assert.deepEqual(
      [...document.querySelectorAll('[aria-label="Presses"] button')].map((b) => b.textContent),
      ["Companion", "App action", "A command"],
    );
  });

  test("a pick writes a command owned by this tile on Home, and Save stores the choice and the label", async () => {
    const { server, saved } = mount(card());
    fireEvent.change(document.querySelector('input[aria-label="Label"]')!, { target: { value: "Refresh" } });
    fireEvent.click(choice("App action"));
    await eventually(() => assert.ok(document.querySelector('[role="option"]')));
    fireEvent.click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Refresh displays")!);
    await eventually(() => assert.equal(server.posts.length, 1));
    assert.deepEqual(server.posts[0]!.ownedBy, { viewId: "home", objectId: "home-cue-button-5-4" });
    assert.equal(saved.length, 0, "nothing is stored until Save");

    await eventually(() => assert.ok(screen.queryByText(/Saved as this button/)));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await eventually(() => assert.equal(saved.length, 1));
    assert.deepEqual(saved[0]!.config, { type: "cue-button", cue: "btn_refresh", showDevice: true, label: "Refresh" });
    assert.equal(saved[0]!.id, "home-cue-button-5-4");
    assert.deepEqual(saved[0]!.home, { size: "s" }, "the rest of the card is untouched");
  });

  test("Cancel stores nothing", async () => {
    const { saved, closes } = mount(card());
    fireEvent.change(document.querySelector('input[aria-label="Label"]')!, { target: { value: "Nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    assert.equal(closes(), 1);
    assert.deepEqual(saved, []);
  });

  test("a tile that already presses a command opens on A command, with it chosen", async () => {
    mount(card({ type: "cue-button", cue: "stage_reset", showDevice: true }));
    await eventually(() => assert.equal(choice("A command").getAttribute("aria-pressed"), "true"));
  });

  test("Save waits for a pick that is still being written, and stores the tile with its command", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    const { server, saved } = mount(card(), { hold });
    fireEvent.click(choice("App action"));
    await eventually(() => assert.ok(document.querySelector('[role="option"]')));
    fireEvent.click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Refresh displays")!);
    await eventually(() => assert.equal(server.posts.length, 1));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(saved.length, 0, "the tile must not be stored before its command is bound");
    release();
    await eventually(() => assert.equal(saved.length, 1));
    assert.match((saved[0]!.config as { cue: string }).cue, /^btn_refresh/, "stored with the command it was just given");
  });

  test("Save writes a field that is still waiting out its delay, and stores the tile with its command", async () => {
    timing.fieldWriteMs = 60_000;
    const { server, saved } = mount(card());
    fireEvent.click(choice("App action"));
    await eventually(() => assert.ok(document.querySelector('[role="option"]')));
    fireEvent.click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Write a log message")!);
    await eventually(() => assert.ok(document.querySelector('[aria-label="Message"]')));
    fireEvent.change(document.querySelector('[aria-label="Message"]')!, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await eventually(() => assert.equal(saved.length, 1));
    assert.equal(server.posts.length, 1);
    assert.match((saved[0]!.config as { cue: string }).cue, /^btn_/);
  });
});
