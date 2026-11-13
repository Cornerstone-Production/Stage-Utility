// The patch device picker on a patch that POST /api/patch accepted but the patch editor would
// never write: a sheet with no devices list, and a device kind that is no kind at all. Each
// once threw inside the inspector, and the error boundary took the unsaved draft with it.
// Every name is invented.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();
const { render, cleanup, screen, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { PatchDeviceField } = await import("./stageplots-patch-link.js");
type FieldProps = Parameters<typeof PatchDeviceField>[0];

afterEach(() => cleanup());
after(() => unmountAndTeardown(cleanup, teardown));

const item: FieldProps["item"] = { id: "c1", type: "conn", x: 0, y: 0, w: 10, h: 10, rotation: 0, label: "", color: null, notes: "", inputs: [] };

async function openPicker(file: unknown) {
  const errors: string[] = [];
  const quiet = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  try {
    await act(async () => {
      render(React.createElement(PatchDeviceField, { item, link: undefined, patch: { ok: true, file } as FieldProps["patch"], dispatch: () => undefined }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Link to patch device" }));
    });
    await settle();
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(errors, [], "the picker logged an error drawing");
}

test("a sheet with no devices list draws, and says it has none", async () => {
  await openPicker({ updatedAt: "", sheets: [{ id: "s1", name: "Loose" }] });
  assert.equal((screen.getByLabelText("Patch sheet") as HTMLSelectElement).value, "s1");
  assert.ok(screen.getByText("No devices on this sheet."));
});

for (const kind of ["__proto__", "constructor", "toString"]) {
  test(`a device of kind "${kind}" is listed as Other`, async () => {
    await openPicker({ updatedAt: "", sheets: [{ id: "s1", name: "Main", devices: [{ id: "d1", name: "Box", kind, inputs: 4, outputs: 0 }] }] });
    assert.deepEqual(
      screen.getAllByRole("option").filter((o) => o.tagName === "BUTTON").map((o) => o.textContent),
      ["BoxOther4 in"],
    );
  });
}
