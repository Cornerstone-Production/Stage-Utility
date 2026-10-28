// Every control in the inspector has a name a screen reader, or a test, can find.
//
// The Row helpers draw a label beside a control and join the two with nothing,
// so a switch reads as "switch" and a field as "edit text" unless the control is
// given its name.
//
// Two layers, because the first alone would have missed most of it. The helpers
// (RowSwitch, RowText, RowNumber, RowSelect, RowToggle, PixelField, the Font
// size rows) are checked one by one. But the inspector also builds controls
// directly from the ui primitives — dozens inside `inspector.tsx` — and a helper
// test says nothing about those. So the second layer mounts the REAL Inspector
// for every object type in the registry, opens its folded options, and asks the
// DOM for every control that has no name.

import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, test } from "node:test";

import type { LayoutObjectType } from "../../main/types/stage.js";
import { LAYOUT_OBJECTS } from "../main/layout-objects.js";
import { DEFAULT_STAGE_STATE } from "../main/test-render-ctx.js";
import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup, fireEvent, within, queryAllByRole } = await import("@testing-library/react");
const React = await import("react");
const { Inspector } = await import("./inspector.js");
const { RowSwitch, RowText, RowNumber, RowSelect, RowToggle, choiceLayout, PixelField, TypeSizeRows, NumberField, NumberInput } =
  await import("./inspector-rows.js");
const { CuePicker } = await import("./cue-picker.js");
const { ActionPicker } = await import("./action-picker.js");
const { PlanAttachmentConfig } = await import("./inspector.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** The roles a form control can take in the inspector. */
const CONTROL_ROLES = ["switch", "checkbox", "textbox", "spinbutton", "combobox", "slider", "radio"] as const;

describe("the Row helpers name their control after their label", () => {
  test("RowSwitch", () => {
    const { getByRole } = render(
      React.createElement(RowSwitch as never, { label: "Warn near the end", checked: false, onChange: () => {} }),
    );
    getByRole("switch", { name: "Warn near the end" });
  });

  test("RowText", () => {
    const { getByRole } = render(
      React.createElement(RowText as never, { label: "Caption", value: "", onChange: () => {} }),
    );
    getByRole("textbox", { name: "Caption" });
  });

  test("RowNumber, with and without a way to clear it", () => {
    const { getByRole } = render(
      React.createElement(
        "div",
        null,
        React.createElement(RowNumber as never, { label: "Opacity", value: 1, onChange: () => {} }),
        React.createElement(RowNumber as never, { label: "Interval", value: null, onChange: () => {}, onUnset: () => {} }),
      ),
    );
    getByRole("textbox", { name: "Opacity" });
    getByRole("textbox", { name: "Interval" });
  });

  test("RowSelect", () => {
    const { getByRole } = render(
      React.createElement(RowSelect as never, {
        label: "Source",
        value: "a",
        options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
        onChange: () => {},
      }),
    );
    getByRole("combobox", { name: "Source" });
  });

  test("RowToggle, as a track for a short list and a dropdown for a long one", () => {
    const two = render(
      React.createElement(RowToggle as never, {
        label: "Shape",
        value: "rect",
        options: [{ value: "rect", label: "Rect" }, { value: "ellipse", label: "Ellipse" }],
        onChange: () => {},
      }),
    );
    // A group, so the two buttons are announced as belonging to "Shape".
    two.getByRole("group", { name: "Shape" });
    two.unmount();

    // Three short words are still a track: the count is not what decides it.
    const three = render(
      React.createElement(RowToggle as never, {
        label: "Fit",
        value: "a",
        options: [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }],
        onChange: () => {},
      }),
    );
    three.getByRole("group", { name: "Fit" });
    three.unmount();

    const five = render(
      React.createElement(RowToggle as never, {
        label: "Weight",
        value: "a",
        options: ["a", "b", "c", "d", "e"].map((v) => ({ value: v, label: v.toUpperCase() })),
        onChange: () => {},
      }),
    );
    five.getByRole("combobox", { name: "Weight" });
  });

  test("choiceLayout: beside, above its label, or a dropdown, by the words and never by the count of three", () => {
    const words = (...w: string[]) => w.map((label) => ({ label }));
    assert.equal(choiceLayout(words("Beside", "Above", "Arranged")), "beside");
    assert.equal(choiceLayout(words("ProPresenter", "One")), "beside");
    assert.equal(choiceLayout(words("Fit", "S", "M", "L")), "beside");
    assert.equal(choiceLayout(words("Service", "ProPresenter", "Baptism")), "above");
    assert.equal(choiceLayout(words("Fit whole picture", "Fill the box")), "above");
    assert.equal(choiceLayout(words("Say it is offline", "Show the logo", "Show nothing")), "dropdown");
    assert.equal(choiceLayout(words("A", "B", "C", "D", "E")), "dropdown");
  });

  test("PixelField", () => {
    const { getByRole } = render(
      React.createElement(PixelField as never, { label: "X", value: 0.5, dim: 1920, onChange: () => {} }),
    );
    getByRole("textbox", { name: "X" });
  });

  test("NumberField and NumberInput pass a name through to the field", () => {
    const { getByRole } = render(
      React.createElement(
        "div",
        null,
        React.createElement(NumberField as never, { "aria-label": "Canvas width", value: 1920, onChange: () => {} }),
        React.createElement(NumberInput as never, { "aria-label": "Opacity", value: 1, onChange: () => {} }),
      ),
    );
    getByRole("textbox", { name: "Canvas width" });
    getByRole("textbox", { name: "Opacity" });
  });

  test("the Font size and Weight rows", () => {
    const { getByRole } = render(
      React.createElement(TypeSizeRows as never, {
        type: "text" as LayoutObjectType,
        style: {},
        canvasHeight: 1080,
        onStyle: () => {},
      }),
    );
    getByRole("textbox", { name: "Font size" });
    getByRole("combobox", { name: "Weight" });
  });
});

describe("the pickers the inspector hosts name themselves", () => {
  test("CuePicker and ActionPicker", () => {
    const { getByRole } = render(
      React.createElement(
        "div",
        null,
        React.createElement(CuePicker as never, { cues: null, value: "", onChange: () => {} }),
        React.createElement(ActionPicker as never, { actions: null, value: "", onChange: () => {} }),
      ),
    );
    getByRole("combobox", { name: "Cue" });
    getByRole("combobox", { name: "Action" });
  });
});

/** Every control in the panel that a screen reader would announce without a name. */
function unnamed(container: HTMLElement): string[] {
  const out: string[] = [];
  for (const role of CONTROL_ROLES) {
    const named = new Set(queryAllByRole(container, role, { name: /./ }));
    for (const el of queryAllByRole(container, role)) {
      if (named.has(el)) continue;
      const row = el.closest("div.flex")?.textContent?.trim().slice(0, 40) ?? "";
      out.push(`${role}${row ? ` beside "${row}"` : ""}`);
    }
  }
  return out;
}

// Two ProPresenter machines, so the instance picker is on screen as well, and
// answers in the shapes the inspector's reads expect: an empty array for a list,
// an object where it reaches into one.
function stubServer(extra?: (url: string) => unknown) {
  const instances = { list: [{ id: "a", name: "Main" }, { id: "b", name: "Overflow" }], status: {}, conn: {} };
  return stubFetchWithLog((url) => {
    const more = extra?.(url);
    if (more !== undefined) return more;
    if (url.endsWith("/api/state")) return ok(DEFAULT_STAGE_STATE);
    if (url.endsWith("/api/propresenter/instances")) return ok(instances);
    if (url.endsWith("/api/rosstalk/targets")) return ok({ targets: [] });
    if (url.includes("/api/cues/manifest")) {
      return ok({ version: 1, server: { name: "Stage Utility", lanUrl: null }, switches: [], buttons: [] });
    }
    return ok([]);
  });
}

const noop = () => {};

async function mountInspector(type: LayoutObjectType, configOver?: Partial<LayoutObjectConfig>) {
  const spec = LAYOUT_OBJECTS[type];
  const config = { ...spec.config(), ...configOver } as LayoutObjectConfig;
  const o: LayoutObject = { id: "o1", x: 0.1, y: 0.1, w: 0.5, h: 0.5, z: 0, config, style: spec.style() };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const utils = render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(Inspector, {
          o,
          canvas: { width: 1920, height: 1080 },
          parentW: 1920,
          parentH: 1080,
          nested: false,
          locked: false,
          slotsViews: [],
          onGeom: noop,
          onStyle: noop,
          onResetLook: noop,
          onConfig: noop,
          onReorder: noop,
          onDuplicate: noop,
          onRemove: noop,
          onReparentOut: noop,
          onToggleLock: noop,
          onSaveGroup: noop,
          onSnapToGrid: noop,
        }),
      ),
    ),
  );
  await settle();
  await settle();
  // The folded controls are controls too.
  const more = within(utils.container).queryByRole("button", { name: "More options" });
  if (more) fireEvent.click(more);
  await settle();
  return utils;
}

describe("the whole Inspector, for every object type", () => {
  let server: ReturnType<typeof stubServer>;
  before(() => {
    server = stubServer();
  });
  // The page-wide state and replay caches would otherwise carry one type's
  // reads into the next.
  afterEach(() => {
    resetStageState();
    resetReplayCache();
  });
  after(() => server.restore());

  // One test per type, so a failure names the widget and a type that cannot
  // mount fails its own case. The registry is the list: a new object type is
  // checked the day it is added.
  for (const type of Object.keys(LAYOUT_OBJECTS) as LayoutObjectType[]) {
    test(type, async () => {
      const { container } = await mountInspector(type);
      assert.deepEqual(unnamed(container), []);
    });
  }

  // Rows the default config does not draw: the lists an operator adds to (a
  // charger's bays, an OSC button's arguments and feedback) and the embedded
  // view's picker.
  test("charger-battery, with bays to label", async () => {
    const { container } = await mountInspector("charger-battery", {
      bays: [{ id: "bay-1" }, { id: "bay-2", label: "Lead" }],
    });
    assert.deepEqual(unnamed(container), []);
  });

  test("slots-grid, embedding a view", async () => {
    const { container } = await mountInspector("slots-grid", { source: "view" });
    assert.ok(within(container).getByRole("combobox", { name: "View" }));
    assert.deepEqual(unnamed(container), []);
  });

  test("osc-button, with arguments and feedback", async () => {
    const { container } = await mountInspector("osc-button", {
      args: [{ type: "i", value: "1" }, { type: "s", value: "x" }],
      feedback: { address: "/ch/01/mix/on", equals: 1 },
    });
    assert.deepEqual(unnamed(container), []);
  });
});

describe("the Plan file inspector, once Planning Center has files to pick from", () => {
  test("the file picker and the crop fields are named", async () => {
    // The picker is drawn only when Planning Center is connected and the plan
    // has a document, which no default mount reaches.
    resetStageState();
    resetReplayCache();
    const f = stubServer((url) => {
      if (url.endsWith("/api/state")) return ok({ ...DEFAULT_STAGE_STATE, pcoConfigured: true });
      if (url.endsWith("/api/pco/attachments")) {
        return ok([{ id: "f1", filename: "stage plot.pdf", contentType: "application/pdf", sourceLabel: "Sunday" }]);
      }
      return undefined;
    });
    try {
      const { container, getByRole } = render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(PlanAttachmentConfig as never, {
            c: { type: "plan-attachment", match: "stage plot" },
            onConfig: noop,
            o: { id: "o1", x: 0, y: 0, w: 0.5, h: 0.5 },
            canvas: { width: 1920, height: 1080, background: null },
            onGeom: noop,
          }),
        ),
      );
      await settle();
      await settle();
      getByRole("combobox", { name: "Current plan" });
      for (const side of ["top", "bottom", "left", "right"]) getByRole("textbox", { name: `Crop ${side}` });
      assert.deepEqual(unnamed(container), []);
    } finally {
      f.restore();
      resetStageState();
      resetReplayCache();
    }
  });
});
