// PathCell: the hop chips on one row, and the guard for the class of bug this
// repo's select-call-site sweep fixed. See select.tsx's own suite
// (../../components/ui/select.test.tsx) for the primitive's contract; this file
// proves ONE real call site still holds the line — that deleting a device does
// not walk the endpoints to clear the hops that name it (patch-path-cell.tsx's own
// comment), so a hop's deviceId can outlive the device list it was chosen from.
//
// A native <select> whose value matches no <option> renders BLANK rather than the
// id it was given (see select.tsx). Reverting the editor's Select back to a raw
// <select> turns the second test red. The first is the same bug on the chip: a
// chip that printed the device's name from a lookup would print nothing for a
// deleted one.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent, screen } = await import("@testing-library/react");
const { PathCell } = await import("./patch-table.js");

after(() => {
  cleanup();
  teardown();
});

const RACK1: PatchDevice = { id: "rack-1", name: "Rack 1", kind: "rack", inputs: 8, outputs: 0 };
const SNAKE: PatchDevice = { id: "snake", name: "Snake", kind: "snake", inputs: 4, outputs: 0, color: "#0091ff" };

describe("PathCell", () => {
  test("a hop naming a deleted device keeps its id on the chip, not blank", () => {
    render(<PathCell path={[{ deviceId: "dev-deleted", connector: "3" }]} stageDevices={[RACK1]} onChange={() => {}} />);
    const chip = screen.getByRole("button", { name: /dev-deleted · 3/ });
    assert.ok(chip.title.includes("no longer"), `the chip must say the device is gone, got ${JSON.stringify(chip.title)}`);
    cleanup();
  });

  test("opening a deleted device's hop shows that id in the select, labelled as not found", () => {
    const { container } = render(<PathCell path={[{ deviceId: "dev-deleted", connector: "3" }]} stageDevices={[RACK1]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /dev-deleted · 3/ }));
    const select = container.querySelector("select");
    assert.ok(select, "no device select rendered for the hop");
    assert.notEqual(select!.selectedIndex, -1, "the device control rendered blank");
    assert.equal(select!.value, "dev-deleted", "the stored device id must be what the control reads");
    const opt = [...select!.options].find((o) => o.value === "dev-deleted");
    assert.ok(opt?.textContent?.includes("not found"), `the stored device id must be labelled as no longer offered, got ${JSON.stringify(opt?.textContent)}`);
    cleanup();
  });

  test("a hop naming a device still in the list shows its name, and offers no stale-value option", () => {
    const { container } = render(<PathCell path={[{ deviceId: "rack-1", connector: "3" }]} stageDevices={[RACK1]} onChange={() => {}} />);
    assert.ok(screen.getByRole("button", { name: /Rack 1 · 3/ }));
    fireEvent.click(screen.getByRole("button", { name: /Rack 1 · 3/ }));
    const select = container.querySelector("select");
    assert.equal(select!.value, "rack-1");
    assert.deepEqual([...select!.options].map((o) => o.textContent), ["— device —", "Rack 1"], "a live device must not also get a stale-value footnote");
    cleanup();
  });

  test("a hop's chip carries the device's color on its dot", () => {
    const { container } = render(<PathCell path={[{ deviceId: "snake", connector: "1" }]} stageDevices={[SNAKE]} onChange={() => {}} />);
    const dot = container.querySelector("button i") as HTMLElement | null;
    assert.equal(dot?.style.getPropertyValue("--dot"), "#0091ff");
    cleanup();
  });

  test("adding a hop hands the new hop to the caller, starting on the first device", () => {
    const calls: PatchHop[][] = [];
    render(<PathCell path={[]} stageDevices={[SNAKE]} onChange={(h) => calls.push(h)} />);
    fireEvent.click(screen.getByRole("button", { name: /direct · add hop/ }));
    assert.deepEqual(calls, [[{ deviceId: "snake", connector: "" }]]);
    cleanup();
  });
});
