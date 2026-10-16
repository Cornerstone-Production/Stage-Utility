// A saved arrangement's row in Slots: its name is an inline field that saves when
// left. The row kept its own copy of the name from the first render on, so a
// preset renamed elsewhere (another window, an import that replaced it) went on
// showing the old text here. It now follows the stored name, and only when the
// stored name changes, so what is being typed is never clobbered.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import type { SlotPreset } from "@main/types/stage";
import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { DndContext } = await import("@dnd-kit/core");
const { SortableContext } = await import("@dnd-kit/sortable");
const { SortablePresetRow } = await import("./slots-section.js");
const { TooltipProvider } = await import("../../components/ui/index.js");

afterEach(cleanup);
after(() => teardown());

type Handlers = Parameters<typeof SortablePresetRow>[0]["handlers"];

function preset(name: string): SlotPreset {
  return { id: "p1", name, slots: [], createdAt: "2026-01-01T00:00:00.000Z" };
}

function Row({ stored, renamed }: { stored: string; renamed: string[] }) {
  const handlers = { handleRenamePreset: (_id: string, name: string) => renamed.push(name) } as unknown as Handlers;
  return (
    <TooltipProvider>
      <DndContext>
        <SortableContext items={["p1"]}>
          <SortablePresetRow preset={preset(stored)} handlers={handlers} />
        </SortableContext>
      </DndContext>
    </TooltipProvider>
  );
}

function field(view: ReturnType<typeof render>): HTMLInputElement {
  return view.container.querySelector<HTMLInputElement>("input[data-preset-id]")!;
}

describe("a preset row's name field", () => {
  test("follows a rename made elsewhere while it is not being edited", () => {
    const view = render(<Row stored="Opening" renamed={[]} />);
    assert.equal(field(view).value, "Opening");
    act(() => {
      view.rerender(<Row stored="Closing" renamed={[]} />);
    });
    assert.equal(field(view).value, "Closing");
  });

  test("keeps what is being typed when something else re-renders it", () => {
    const view = render(<Row stored="Opening" renamed={[]} />);
    act(() => {
      fireEvent.change(field(view), { target: { value: "Open" } });
    });
    act(() => {
      view.rerender(<Row stored="Opening" renamed={[]} />);
    });
    assert.equal(field(view).value, "Open");
  });

  test("saves a changed name trimmed on blur, and puts the stored one back for an emptied field", () => {
    const renamed: string[] = [];
    const view = render(<Row stored="Opening" renamed={renamed} />);
    act(() => {
      fireEvent.change(field(view), { target: { value: "  Welcome  " } });
    });
    act(() => {
      fireEvent.blur(field(view));
    });
    assert.deepEqual(renamed, ["Welcome"]);

    act(() => {
      fireEvent.change(field(view), { target: { value: "   " } });
    });
    act(() => {
      fireEvent.blur(field(view));
    });
    assert.equal(field(view).value, "Opening");
    assert.deepEqual(renamed, ["Welcome"]);
  });
});
