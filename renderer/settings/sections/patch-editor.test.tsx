// patch-editor.test.tsx — the editor's interactions, driven the way an operator
// drives them: through the real PatchSection with a stubbed server.
//
// What each group guards, and what it would take to break it:
//   ripple      a fill reaches the run below, the reach is drawn, it disarms once,
//               and the bar a chip is pressed in does not move under the pointer
//   hops        a hop is added, edited and removed from the chip on the row
//   sheet menu  Rename and Delete live on the active tab; the confirm names the sheet
//   export      unavailable while unsaved, and each format is a link to the saved sheet
//   devices     a device opens its editor from the list
//
// jsdom loads no stylesheet and measures nothing, so what this cannot see is
// verified in a browser instead, and is not asserted here: the 32px row height,
// the accent focus ring, "+ hop" appearing on row hover (opacity, not
// presence), the sticky ripple bar, and the print layout.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert inspects
// `actual` to build its failure message, and inspecting a live jsdom element does
// not finish. Every query is coerced to a boolean or a string first.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent, within, act } = await import("@testing-library/react");
const React = await import("react");
const { PatchSection } = await import("./patch-section.js");
const { ConfirmHost, TooltipProvider } = await import("../../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const RACK: PatchDevice = { id: "rack", name: "Main Rack", kind: "rack", inputs: 8, outputs: 4 };
const SNAKE_A: PatchDevice = { id: "snA", name: "Snake A", kind: "snake", inputs: 8, outputs: 0, color: "#0091ff", inLabels: Array.from({ length: 8 }, (_, i) => `A-${i + 1}`) };
const SNAKE_B: PatchDevice = { id: "snB", name: "Snake B", kind: "snake", inputs: 8, outputs: 0 };

const ep = (index: number, rest: Partial<PatchEndpoint>): PatchEndpoint => ({ rackId: "rack", dir: "in", index, ...rest });

const fixture = (): PatchFile => ({
  sheets: [
    {
      id: "analog",
      name: "Analog",
      kind: "analog",
      devices: [RACK, SNAKE_A, SNAKE_B],
      endpoints: [
        ep(1, { label: "Kick 1", consoleChannel: "1", mic: "Beta 91", path: [{ deviceId: "snA", connector: "A-1" }] }),
        ep(2, { label: "Snare", consoleChannel: "2", path: [{ deviceId: "snA", connector: "A-2" }] }),
        ep(3, { label: "Gone", path: [{ deviceId: "dev-deleted", connector: "9" }] }),
        ep(6, { label: "Spare" }),
      ],
      variants: [{ id: "var1", name: "Acoustic", overrides: {} }],
      assignments: { byServiceType: {}, byPlan: {} },
    },
    {
      id: "dante",
      name: "Dante",
      kind: "dante",
      devices: [{ id: "drack", name: "Dante Rack", kind: "rack", inputs: 2, outputs: 0 }],
      endpoints: [{ rackId: "drack", dir: "in", index: 1, label: "Stage L", owner: "FOH" }],
      variants: [],
      assignments: { byServiceType: {}, byPlan: {} },
    },
  ],
  updatedAt: "2026-10-16T12:00:00.000Z",
});

/** The server: serves the file, and keeps what was saved. */
function stubServer() {
  const saves: PatchFile[] = [];
  let current = fixture();
  const f = stubFetchWithLog((url, init) => {
    if (url.endsWith("/api/patch")) {
      if (init?.method === "POST") {
        const file = (JSON.parse(String(init.body)) as { file: PatchFile }).file;
        saves.push(file);
        current = file;
        return ok(file);
      }
      return ok(current);
    }
    if (url.includes("/api/state")) return ok({ serviceTypeId: "st1", planId: "p1", planTitle: "Sunday", allowedServiceTypeIds: [], pcoConfigured: true });
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    return ok({});
  });
  return { ...f, saves };
}

async function mount(): Promise<void> {
  render(React.createElement(TooltipProvider, null, React.createElement(PatchSection), React.createElement(ConfirmHost)));
  await eventually(() => assert.equal(!!screen.queryByRole("tab", { name: "Analog" }), true, "the patch loaded"));
  await settle();
}

const rack = () => within(screen.getByRole("region", { name: "Main Rack" }));
const sourceOf = (row: number) => rack().getAllByLabelText("Source")[row - 1] as HTMLInputElement;
const type = (el: HTMLElement, value: string) => act(async () => { fireEvent.change(el, { target: { value } }); });
/** Real focus, so React's onFocus/onBlur on the row run as they do in a browser. */
const focus = (el: HTMLElement) => act(async () => { el.focus(); });
const blur = (el: HTMLElement) => act(async () => { el.blur(); });
const hasText = (t: RegExp | string) => !!screen.queryByText(t);

/** Open a Radix menu from its trigger, the way a keyboard does. */
async function openMenu(trigger: HTMLElement) {
  await act(async () => { fireEvent.keyDown(trigger, { key: "Enter" }); });
  await settle();
}

describe("ripple", () => {
  const arm = async () => {
    await act(async () => { fireEvent.click(screen.getByRole("switch", { name: "Ripple" })); });
  };
  const bar = () => within(screen.getAllByRole("group", { name: "Ripple options" })[0]);
  const press = (name: string) => act(async () => { fireEvent.click(bar().getByRole("button", { name: new RegExp(`^${name}$`) })); });

  test("a fill reaches the chosen run, highlights it, and disarms after one use", async () => {
    const f = stubServer();
    try {
      await mount();
      await arm();
      await press("4");
      await press("Source");
      await focus(sourceOf(4));
      // The reach is the focused row and the three below it.
      const reach = () => [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => sourceOf(n).closest("tr")?.hasAttribute("data-reach"));
      assert.deepEqual(reach(), [4, 5, 6, 7]);

      await type(sourceOf(4), "Vox 1");
      assert.deepEqual([4, 5, 6, 7, 8].map((n) => sourceOf(n).value), ["Vox 1", "Vox 2", "Vox 3", "Vox 4", ""], "four channels filled, the fifth untouched");

      // One-shot: leaving the cell disarms it.
      await blur(sourceOf(4));
      await eventually(() => assert.equal(screen.getByRole("switch", { name: "Ripple" }).getAttribute("aria-checked"), "false"));
      assert.equal(screen.queryAllByRole("group", { name: "Ripple options" }).length, 0, "the bar goes with it");
    } finally {
      f.restore();
    }
  });

  test("disarmed, an edit changes one cell", async () => {
    const f = stubServer();
    try {
      await mount();
      await type(sourceOf(4), "Vox 1");
      assert.deepEqual([4, 5].map((n) => sourceOf(n).value), ["Vox 1", ""]);
    } finally {
      f.restore();
    }
  });

  test("the bar keeps saying where the fill starts after the row loses focus", async () => {
    // Pressing a chip blurs the row. A bar whose "from row N" text vanished on
    // that blur shifted its chips left between mousedown and mouseup in a
    // browser, and the click landed on nothing.
    const f = stubServer();
    try {
      await mount();
      await arm();
      await focus(sourceOf(2));
      assert.match(bar().getByText(/from row 2/).textContent ?? "", /from row 2/);
      await blur(sourceOf(2));
      assert.equal(!!bar().queryByText(/from row 2/), true, "the 'from row' text must survive the blur");
    } finally {
      f.restore();
    }
  });

  test("the start row does not outlive a switch between Inputs and Outputs", async () => {
    const f = stubServer();
    try {
      await mount();
      await arm();
      await focus(sourceOf(5));
      assert.equal(!!bar().queryByText(/from row 5/), true);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Outputs" })); });
      assert.equal(!!bar().queryByText(/from row/), false, "nothing is focused on the other direction's rows");
    } finally {
      f.restore();
    }
  });

  test("re-arming starts with no start row", async () => {
    const f = stubServer();
    try {
      await mount();
      await arm();
      await focus(sourceOf(2));
      assert.equal(!!bar().queryByText(/from row 2/), true);
      await act(async () => { fireEvent.click(screen.getByRole("switch", { name: "Ripple" })); });
      await arm();
      assert.equal(!!bar().queryByText(/from row/), false, "the last arming's row must not come back");
    } finally {
      f.restore();
    }
  });

  test("a non-analog sheet offers an Owner fill", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Dante" })); });
      await arm();
      assert.equal(!!bar().queryByRole("button", { name: "Owner" }), true);
      await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Analog" })); });
      assert.equal(!!bar().queryByRole("button", { name: "Owner" }), false, "analog has no Owner column");
    } finally {
      f.restore();
    }
  });
});

describe("hops", () => {
  const row = (n: number) => within(sourceOf(n).closest("tr") as HTMLElement);

  test("an empty row reads 'direct · add hop', and adding a hop opens its editor", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(row(4).getByRole("button", { name: /direct · add hop/ })); });
      const editor = row(4).getByRole("group", { name: "Edit hop" });
      assert.equal((within(editor).getByLabelText("Device") as HTMLSelectElement).value, "snA", "a new hop starts on the first stage device");
      await type(within(editor).getByLabelText("Connector"), "A-4");
      // Closing the editor leaves the hop as a chip.
      await act(async () => { fireEvent.keyDown(within(editor).getByLabelText("Connector"), { key: "Enter" }); });
      assert.equal(row(4).queryAllByRole("group", { name: "Edit hop" }).length, 0);
      assert.equal(!!row(4).queryByRole("button", { name: /Snake A · A-4/ }), true);
    } finally {
      f.restore();
    }
  });

  test("a chip edits in place and the edit lands in the row", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(row(1).getByRole("button", { name: /Snake A · A-1/ })); });
      const editor = row(1).getByRole("group", { name: "Edit hop" });
      await type(within(editor).getByLabelText("Device"), "snB");
      await type(within(editor).getByLabelText("Connector"), "B-5");
      await act(async () => { fireEvent.keyDown(within(editor).getByLabelText("Connector"), { key: "Escape" }); });
      assert.equal(!!row(1).queryByRole("button", { name: /Snake B · B-5/ }), true);
      assert.equal(hasText("Unsaved changes"), true);
    } finally {
      f.restore();
    }
  });

  test("a hop is removed from its editor", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(row(2).getByRole("button", { name: /Snake A · A-2/ })); });
      await act(async () => { fireEvent.click(row(2).getByRole("button", { name: "Remove hop" })); });
      assert.equal(!!row(2).queryByRole("button", { name: /direct · add hop/ }), true, "back to a direct row");
      assert.equal(!!row(2).queryByRole("button", { name: /Snake A/ }), false);
    } finally {
      f.restore();
    }
  });

  test("Enter closes the editor and returns focus to the hop's chip", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(row(1).getByRole("button", { name: /Snake A · A-1/ })); });
      const connector = row(1).getByLabelText("Connector");
      const chip = () => row(1).getByRole("button", { name: /Snake A · A-1/ });
      // Synchronously, inside the key's own handling: focus must NOT have moved yet.
      // A browser activates whatever button holds focus when Enter's default action
      // runs, so a chip focused here would be pressed by the same keystroke and
      // reopen the editor it just closed (seen in Chrome; jsdom cannot press it).
      act(() => { fireEvent.keyDown(connector, { key: "Enter" }); });
      assert.ok(document.activeElement !== chip(), "focus moved to the chip before the keystroke finished");
      await eventually(() => assert.ok(document.activeElement === chip(), "focus must land on the chip"));
    } finally {
      f.restore();
    }
  });

  test("with an editor open, pressing another chip keeps focus where it is, so one click opens that chip", async () => {
    // A mousedown that moved focus would close the open editor, which turns back
    // into a narrower chip and shifts the pressed chip left before mouseup.
    const f = stubServer();
    try {
      await mount();
      // Row 1 has one hop; add a second so a chip sits beside the open editor.
      await act(async () => { fireEvent.click(row(1).getByRole("button", { name: "Add hop" })); });
      assert.equal(row(1).queryAllByRole("group", { name: "Edit hop" }).length, 1, "the new hop's editor is open");
      const chip = row(1).getByRole("button", { name: /Snake A · A-1/ });
      assert.equal(fireEvent.mouseDown(chip), false, "mousedown on a chip must be default-prevented while an editor is open");
      await act(async () => { fireEvent.click(chip); });
      assert.equal(row(1).queryAllByRole("button", { name: /Snake A · A-1/ }).length, 0, "that chip is now the open editor");
    } finally {
      f.restore();
    }
  });

  test("every channel row has a row header, so a bare Source field says which channel it is", async () => {
    const f = stubServer();
    try {
      await mount();
      const headers = within(screen.getByRole("region", { name: "Main Rack" })).getAllByRole("rowheader").map((h) => h.textContent);
      assert.deepEqual(headers, ["1", "2", "3", "4", "5", "6", "7", "8"]);
    } finally {
      f.restore();
    }
  });

  test("a hop naming a deleted device keeps its id on the chip, never blank", async () => {
    const f = stubServer();
    try {
      await mount();
      assert.equal(!!row(3).queryByRole("button", { name: /dev-deleted · 9/ }), true);
    } finally {
      f.restore();
    }
  });
});

describe("sheet tab menu", () => {
  const menuTrigger = () => screen.getByRole("button", { name: /Rename or delete Analog/ });

  test("Rename edits the tab in place, committing on Enter", async () => {
    const f = stubServer();
    try {
      await mount();
      await openMenu(menuTrigger());
      await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Rename" })); });
      const input = await eventually(() => screen.getByLabelText("Sheet name") as HTMLInputElement);
      assert.equal(input.value, "Analog");
      await type(input, "Stage");
      await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
      assert.equal(!!screen.queryByRole("tab", { name: "Stage" }), true);
      assert.equal(screen.queryAllByLabelText("Sheet name").length, 0, "the input is gone");
      assert.equal(hasText("Unsaved changes"), true);
    } finally {
      f.restore();
    }
  });

  test("Escape keeps the old name", async () => {
    const f = stubServer();
    try {
      await mount();
      await openMenu(menuTrigger());
      await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Rename" })); });
      const input = await eventually(() => screen.getByLabelText("Sheet name") as HTMLInputElement);
      await type(input, "Nope");
      await act(async () => { fireEvent.keyDown(input, { key: "Escape" }); });
      assert.equal(!!screen.queryByRole("tab", { name: "Analog" }), true);
      assert.equal(hasText("Unsaved changes"), false, "an abandoned rename is not an edit");
    } finally {
      f.restore();
    }
  });

  test("Delete asks by name, and removes the sheet only on confirm", async () => {
    const f = stubServer();
    try {
      await mount();
      await openMenu(menuTrigger());
      await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /Delete sheet/ })); });
      const dialog = await eventually(() => screen.getByRole("alertdialog"));
      assert.equal(!!within(dialog).queryByText('Delete the "Analog" sheet, including its devices and patch?'), true);
      await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })); });
      await settle();
      assert.equal(!!screen.queryByRole("tab", { name: "Analog" }), true, "cancel keeps the sheet");

      await openMenu(menuTrigger());
      await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /Delete sheet/ })); });
      const again = await eventually(() => screen.getByRole("alertdialog"));
      await act(async () => { fireEvent.click(within(again).getByRole("button", { name: "Delete" })); });
      await eventually(() => assert.equal(!!screen.queryByRole("tab", { name: "Analog" }), false));
      assert.equal(!!screen.queryByRole("tab", { name: "Dante" }), true);
    } finally {
      f.restore();
    }
  });

  test("the last sheet cannot be deleted", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Dante" })); });
      await openMenu(screen.getByRole("button", { name: /Rename or delete Dante/ }));
      await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /Delete sheet/ })); });
      await eventually(() => assert.equal(!!screen.queryByRole("alertdialog"), true));
      await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" })); });
      await eventually(() => assert.equal(!!screen.queryByRole("tab", { name: "Dante" }), false));
      // One sheet left: its Delete is disabled, not hidden.
      await openMenu(screen.getByRole("button", { name: /Rename or delete Analog/ }));
      assert.equal(screen.getByRole("menuitem", { name: /Delete sheet/ }).getAttribute("aria-disabled"), "true");
    } finally {
      f.restore();
    }
  });

  test("+ adds a custom sheet named for its position", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add sheet" })); });
      assert.equal(!!screen.queryByRole("tab", { name: "Sheet 3" }), true);
      assert.equal(screen.getByRole("tab", { name: "Sheet 3" }).getAttribute("aria-selected"), "true");
    } finally {
      f.restore();
    }
  });
});

describe("export", () => {
  const trigger = () => screen.getByRole("button", { name: /Export/ });

  test("is unavailable while there are unsaved edits, and says why", async () => {
    const f = stubServer();
    try {
      await mount();
      assert.equal((trigger() as HTMLButtonElement).disabled, false, "a clean sheet can be exported");
      await type(sourceOf(5), "Edited");
      await eventually(() => assert.equal((trigger() as HTMLButtonElement).disabled, true));
      assert.equal(trigger().getAttribute("title"), "Save your changes first — the export comes from the saved sheet");
    } finally {
      f.restore();
    }
  });

  test("after Save, each format is a link to the saved sheet", async () => {
    const f = stubServer();
    try {
      await mount();
      await type(sourceOf(5), "Edited");
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
      await eventually(() => assert.equal((trigger() as HTMLButtonElement).disabled, false));
      assert.equal(f.saves.length, 1, "saved once");
      await openMenu(trigger());
      const links = Object.fromEntries(screen.getAllByRole("menuitem").map((a) => [a.textContent, a.getAttribute("href")]));
      assert.deepEqual(links, {
        "Export CSV": "/api/patch/export?sheetId=analog&format=csv",
        "Export Excel": "/api/patch/export?sheetId=analog&format=xlsx",
      });
    } finally {
      f.restore();
    }
  });

  test("exports the variant being edited", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.change(screen.getByLabelText("Patch being edited"), { target: { value: "var1" } }); });
      await openMenu(trigger());
      assert.equal(screen.getByRole("menuitem", { name: "Export CSV" }).getAttribute("href"), "/api/patch/export?sheetId=analog&format=csv&variantId=var1");
    } finally {
      f.restore();
    }
  });
});

describe("exportUrl", () => {
  test("This week names the plan and its service type, and ignores a variant", async () => {
    const { exportUrl } = await import("./patch-export.js");
    assert.equal(exportUrl("xlsx", "analog", "var1", { planId: "p1", serviceTypeId: "st1" }), "/api/patch/export?sheetId=analog&format=xlsx&planId=p1&serviceTypeId=st1");
    assert.equal(exportUrl("csv", "analog", null, { planId: "p1", serviceTypeId: null }), "/api/patch/export?sheetId=analog&format=csv&planId=p1");
  });
});

describe("variant bar", () => {
  test("a variant shows its name, delete and the diff note; the default shows New variant", async () => {
    const f = stubServer();
    try {
      await mount();
      assert.equal(!!screen.queryByRole("button", { name: "New variant" }), true);
      await act(async () => { fireEvent.change(screen.getByLabelText("Patch being edited"), { target: { value: "var1" } }); });
      assert.equal((screen.getByLabelText("Variant name") as HTMLInputElement).value, "Acoustic");
      assert.equal(!!screen.queryByRole("button", { name: "Delete variant" }), true);
      assert.equal(hasText("Only changes vs the default are saved."), true);
      assert.equal(!!screen.queryByRole("button", { name: "New variant" }), false);
    } finally {
      f.restore();
    }
  });

  test("This week is offered with the plan's title, and notes what it does", async () => {
    const f = stubServer();
    try {
      await mount();
      const option = await eventually(() => screen.getByRole("option", { name: "This week — Sunday" }));
      await act(async () => { fireEvent.change(screen.getByLabelText("Patch being edited"), { target: { value: (option as HTMLOptionElement).value } }); });
      assert.equal(hasText("One-off tweaks for this week only — saved over the assigned base."), true);
    } finally {
      f.restore();
    }
  });
});

describe("grouping", () => {
  test("changing a hop's device in By device keeps its editor open, though the row moves group", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "By device" })); });
      const snakeA = within(screen.getByRole("region", { name: "Snake A" }));
      await act(async () => { fireEvent.click(snakeA.getAllByRole("button", { name: /Snake A · A-1/ })[0]); });
      await type(within(screen.getByRole("group", { name: "Edit hop" })).getByLabelText("Device"), "snB");
      // The row is now under Snake B, and its editor came with it.
      const snakeB = within(screen.getByRole("region", { name: "Snake B" }));
      assert.equal(snakeB.queryAllByRole("group", { name: "Edit hop" }).length, 1, "the editor must follow the row to its new group");
    } finally {
      f.restore();
    }
  });

  test("By device groups by the first hop's device, with the rest under Direct to rack", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "By device" })); });
      const headings = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
      assert.deepEqual(headings.filter((h) => h === "Snake A" || h === "dev-deleted" || h === "Direct to rack"), ["Snake A", "dev-deleted", "Direct to rack"]);
      assert.equal(screen.queryAllByRole("switch", { name: "Ripple" }).length, 0, "ripple fills down a rack, so it is not offered here");
    } finally {
      f.restore();
    }
  });
});

describe("devices", () => {
  const devices = () => within(screen.getByRole("region", { name: "Devices" }));

  test("a device opens its editor from the list, and a rename reaches the hops that name it", async () => {
    const f = stubServer();
    try {
      await mount();
      assert.equal(devices().queryAllByLabelText("Device name").length, 0, "closed until clicked");
      await act(async () => { fireEvent.click(devices().getByRole("button", { name: /^Snake A/ })); });
      await type(devices().getByLabelText("Device name"), "Snake Q");
      assert.equal(!!devices().queryByRole("button", { name: /^Snake Q/ }), true);
      // A hop names its device by id, so the chip on the sheet follows the rename.
      const row1 = within(sourceOf(1).closest("tr") as HTMLElement);
      assert.equal(!!row1.queryByRole("button", { name: /Snake Q · A-1/ }), true);
      assert.equal(hasText("Unsaved changes"), true);
    } finally {
      f.restore();
    }
  });

  test("Add device adds a rack and opens its editor", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(devices().getByRole("button", { name: "Add device" })); });
      assert.equal((devices().getByLabelText("Device name") as HTMLInputElement).value, "Device 4");
      assert.equal(!!screen.queryByRole("region", { name: "Device 4" }), true, "a new Input Rack is a card on the sheet");
      await eventually(() => assert.ok(document.activeElement === devices().getByLabelText("Device name"), "the new device's name is ready to type"));
    } finally {
      f.restore();
    }
  });

  test("reopening an added device does not grab focus again", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(devices().getByRole("button", { name: "Add device" })); });
      const row = () => devices().getByRole("button", { name: /^Device 4/ });
      await act(async () => { fireEvent.click(row()); });          // collapse
      await act(async () => { fireEvent.click(row()); });          // reopen
      await settle();
      assert.ok(document.activeElement !== devices().getByLabelText("Device name"), "only the opening Add device caused should focus the name");
    } finally {
      f.restore();
    }
  });

  test("connector labels generate and clear", async () => {
    const f = stubServer();
    try {
      await mount();
      await act(async () => { fireEvent.click(devices().getByRole("button", { name: /Snake B/ })); });
      await type(devices().getByLabelText("Prefix"), "B-");
      await act(async () => { fireEvent.click(devices().getByRole("button", { name: "Label 8 inputs" })); });
      assert.equal(hasText("in B-1…B-8"), true);
      await act(async () => { fireEvent.click(devices().getByRole("button", { name: "Clear" })); });
      assert.equal(hasText("in B-1…B-8"), false);
    } finally {
      f.restore();
    }
  });
});
