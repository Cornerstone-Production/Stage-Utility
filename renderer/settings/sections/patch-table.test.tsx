// PathCell's device-hop picker: the guard for the class of bug this repo's
// select-call-site sweep fixed. See select.tsx's own suite
// (../../components/ui/select.test.tsx) for the primitive's contract; this
// file proves ONE real call site still holds the line — that deleting a
// device does not walk the endpoints to clear the hops that name it
// (patch-table.tsx's own comment), so a hop's deviceId can outlive the
// device list it was chosen from. A native <select> whose value matches no
// <option> renders BLANK rather than the id it was given (see select.tsx).
// Reverting PathCell's Select back to a raw <select> turns this red.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { PathCell } = await import("./patch-table.js");

after(() => {
  cleanup();
  teardown();
});

const RACK1: PatchDevice = { id: "rack-1", name: "Rack 1", kind: "rack", inputs: 8, outputs: 0 };

describe("PathCell's device select", () => {
  test("a hop naming a deleted device still shows that id, not blank", () => {
    const { container } = render(
      <PathCell
        path={[{ deviceId: "dev-deleted", connector: "3" }]}
        stageDevices={[RACK1]}
        onChange={() => {}}
      />,
    );
    const select = container.querySelector("select");
    assert.ok(select, "no device select rendered for the hop");
    assert.notEqual(select!.selectedIndex, -1, "the device control rendered blank");
    assert.equal(select!.value, "dev-deleted", "the stored device id must be what the control reads");
    const opt = [...select!.options].find((o) => o.value === "dev-deleted");
    assert.ok(
      opt?.textContent?.includes("not found"),
      `the stored device id must be labelled as no longer offered, got ${JSON.stringify(opt?.textContent)}`,
    );
    cleanup();
  });

  test("a hop naming a device still in the list shows it normally", () => {
    const { container } = render(
      <PathCell
        path={[{ deviceId: "rack-1", connector: "3" }]}
        stageDevices={[RACK1]}
        onChange={() => {}}
      />,
    );
    const select = container.querySelector("select");
    assert.equal(select!.value, "rack-1");
    assert.deepEqual(
      [...select!.options].map((o) => o.textContent),
      ["— device —", "Rack 1"],
      "a live device must not also get a stale-value footnote",
    );
    cleanup();
  });
});
