// The Lyrics inspector: the controls the approved mockup lists, in its groups, and
// that each one writes the field it names.
//
// Driven through the real Inspector, as timer-inspector.test.tsx is, so the wiring
// into it (the Look section's type rows, the ProPresenter picker) is on the path
// too. A control that renders is not a control that writes the right key.
//
// NOT covered: the stacked layout and the segmented controls' look — jsdom loads
// no stylesheet, so those were checked in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import type { LayoutObject, LayoutObjectConfig } from "@main/types/views";
import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup, fireEvent, within } = await import("@testing-library/react");
const React = await import("react");
const { Inspector } = await import("./inspector.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { DEFAULT_STAGE_STATE } = await import("../main/test-render-ctx.js");
const { LAYOUT_OBJECTS } = await import("../main/layout-objects.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

async function mount(config: Record<string, unknown>, instances = [{ id: "default", name: "Main" }]) {
  const f = stubFetchWithLog((url) =>
    url.endsWith("/api/state") ? ok(DEFAULT_STAGE_STATE)
    : url.includes("/api/propresenter/instances")
      ? ok({ list: instances, conn: {}, status: Object.fromEntries(instances.map((i) => [i.id, { connected: true, timers: [] }])) })
      : ok({}),
  );
  const writes: LayoutObjectConfig[] = [];
  const o = { id: "l1", x: 0.1, y: 0.1, w: 0.5, h: 0.5, z: 0, config, style: { color: "#ffffff" } } as LayoutObject;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const noop = () => {};
  const utils = render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(Inspector, {
          o, canvas: { width: 1920, height: 1080 }, parentW: 1920, parentH: 1080, nested: false, locked: false,
          slotsViews: [], onGeom: noop, onStyle: noop, onResetLook: noop,
          onConfig: (c: LayoutObjectConfig) => writes.push(c),
          onReorder: noop, onDuplicate: noop, onRemove: noop, onReparentOut: noop, onToggleLock: noop, onSaveGroup: noop, onSnapToGrid: noop,
        }),
      ),
    ),
  );
  await settle();
  await settle();
  return { ...utils, writes, restore: f.restore };
}

type M = Awaited<ReturnType<typeof mount>>;
const group = (m: M, label: string) => m.container.querySelector(`[role="group"][aria-label="${label}"]`) as HTMLElement;
const pick = (m: M, groupLabel: string, option: string) => fireEvent.click(within(group(m, groupLabel)).getByRole("button", { name: option }));
const pressed = (m: M, groupLabel: string) =>
  [...group(m, groupLabel).querySelectorAll("button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);

/** A new Lyrics object, as the palette creates it: every setting stated. */
const created = () => LAYOUT_OBJECTS.lyrics.config() as Record<string, unknown>;

describe("what the inspector offers", () => {
  test("the mockup's groups, controls and choices", async () => {
    const m = await mount(created());
    try {
      const choices: [string, string[]][] = [
        ["Group tag", ["Beside", "Above", "Arrangement"]],
        ["Style", ["Filled", "Outline", "Text"]],
        ["Colour", ["ProPresenter", "One colour"]],
        ["Text", ["As named", "Short", "CAPS"]],
        ["Width (beside)", ["Column", "Fit"]],
        ["Size", ["Fit", "S", "M", "L"]],
        ["Weight", ["Regular", "Bold"]],
        ["Align (above)", ["Left", "Centre"]],
        ["No words", ["Blank", "Tag only"]],
        ["Shows", ["Next slide", "Next group"]],
        ["Dimmed", ["A little", "More"]],
      ];
      for (const [label, options] of choices) {
        const g = group(m, label);
        assert.ok(g, `no "${label}" control`);
        assert.deepEqual([...g.querySelectorAll("button")].map((b) => b.textContent), options, label);
      }
      for (const l of ["Show what comes next", "Its lyrics", "Song title"]) {
        assert.ok(m.getByRole("switch", { name: l }), `no "${l}" switch`);
      }
      for (const h of ["Layout", "Group tag", "Lyrics", "Underneath"]) {
        assert.ok([...m.container.querySelectorAll("span")].some((s) => s.textContent === h), `no "${h}" heading`);
      }
    } finally {
      m.restore();
    }
  });

  test("an object that states nothing opens on the approved default", async () => {
    const m = await mount({ type: "lyrics" });
    try {
      const expected: [string, string][] = [
        ["Group tag", "Above"], ["Style", "Filled"], ["Colour", "ProPresenter"], ["Text", "As named"], ["Width (beside)", "Column"],
        ["Size", "L"], ["Weight", "Bold"], ["Align (above)", "Left"], ["No words", "Tag only"], ["Shows", "Next group"], ["Dimmed", "A little"],
      ];
      for (const [label, option] of expected) assert.deepEqual(pressed(m, label), [option], label);
      assert.equal(m.getByRole("switch", { name: "Show what comes next" }).getAttribute("aria-checked"), "true");
      assert.equal(m.getByRole("switch", { name: "Its lyrics" }).getAttribute("aria-checked"), "false");
      assert.equal(m.getByRole("switch", { name: "Song title" }).getAttribute("aria-checked"), "false");
    } finally {
      m.restore();
    }
  });
});

describe("each control writes the field it names, and keeps the rest", () => {
  // One non-default option per segmented control, so the write differs from what
  // was there. Width and Align are covered separately: each is greyed in the
  // layout the default is in.
  const cases: [string, string, string, string][] = [
    ["Group tag", "Beside", "display", "beside"],
    ["Group tag", "Arrangement", "display", "strip"],
    ["Style", "Outline", "tagStyle", "outline"],
    ["Style", "Text", "tagStyle", "text"],
    ["Colour", "One colour", "tagColor", "one"],
    ["Text", "Short", "tagText", "short"],
    ["Text", "CAPS", "tagText", "caps"],
    ["Size", "Fit", "size", "fit"],
    ["Size", "S", "size", "s"],
    ["Size", "M", "size", "m"],
    ["Weight", "Regular", "weight", "regular"],
    ["No words", "Blank", "noWords", "blank"],
    ["Shows", "Next slide", "underShows", "slide"],
    ["Dimmed", "More", "underDim", "strong"],
  ];
  for (const [groupLabel, option, key, value] of cases) {
    test(`${groupLabel}: ${option} writes ${key}=${value}`, async () => {
      const m = await mount(created());
      try {
        pick(m, groupLabel, option);
        assert.deepEqual(m.writes.at(-1), { ...created(), [key]: value });
      } finally {
        m.restore();
      }
    });
  }

  test("Width and Align, in the layouts they apply to", async () => {
    const beside = await mount({ ...created(), display: "beside" });
    try {
      pick(beside, "Width (beside)", "Fit");
      assert.equal((beside.writes.at(-1) as { tagWidth?: string }).tagWidth, "fit");
    } finally {
      beside.restore();
    }
    cleanup();
    const above = await mount(created());
    try {
      pick(above, "Align (above)", "Centre");
      assert.equal((above.writes.at(-1) as { align?: string }).align, "center");
    } finally {
      above.restore();
    }
  });

  test("the switches", async () => {
    const m = await mount(created());
    try {
      fireEvent.click(m.getByRole("switch", { name: "Show what comes next" }));
      assert.equal((m.writes.at(-1) as { under?: boolean }).under, false);
      fireEvent.click(m.getByRole("switch", { name: "Its lyrics" }));
      assert.equal((m.writes.at(-1) as { underWords?: boolean }).underWords, true);
      fireEvent.click(m.getByRole("switch", { name: "Song title" }));
      assert.equal((m.writes.at(-1) as { showTitle?: boolean }).showTitle, true);
    } finally {
      m.restore();
    }
  });
});

describe("a control that would change nothing is greyed, not live", () => {
  test("Width is for Beside only, Align for Above and the Arrangement only", async () => {
    const above = await mount(created());
    try {
      pick(above, "Width (beside)", "Fit");
      assert.equal(above.writes.length, 0, "Width wrote while the tag is above");
    } finally {
      above.restore();
    }
    cleanup();
    const beside = await mount({ ...created(), display: "beside" });
    try {
      pick(beside, "Align (above)", "Centre");
      assert.equal(beside.writes.length, 0, "Align wrote while the tag is beside");
    } finally {
      beside.restore();
    }
  });

  test("everything underneath waits on Show what comes next", async () => {
    const m = await mount({ ...created(), under: false });
    try {
      pick(m, "Shows", "Next slide");
      pick(m, "Dimmed", "More");
      assert.equal(m.writes.length, 0, "a setting under a switched-off Underneath wrote");
      assert.equal((m.getByRole("switch", { name: "Its lyrics" }) as HTMLButtonElement).disabled, true);
    } finally {
      m.restore();
    }
  });
});

describe("the rest of the inspector, for this widget", () => {
  test("Look offers no font size, weight or alignment pad: the widget's own settings are those", async () => {
    const m = await mount(created());
    try {
      assert.ok(m.container.querySelector('[aria-label="Font size"]') === null, "a Font size that changes nothing");
      assert.ok(m.container.querySelector('[aria-label="Alignment"]') === null, "an Align pad that changes nothing");
      assert.match(m.container.textContent ?? "", /sets its own type: Size, Weight and Align are under Lyrics above/);
      // The text colour is the one style it reads, so it stays.
      assert.ok(m.container.querySelector('[aria-label="Text colour"]'), "no text colour");
    } finally {
      m.restore();
    }
  });

  test("the ProPresenter picker appears only with more than one instance", async () => {
    const one = await mount(created());
    try {
      assert.ok(one.container.querySelector('[aria-label="ProPresenter"]') === null, "expected nothing to be drawn");
    } finally {
      one.restore();
    }
    cleanup();
    const two = await mount(created(), [{ id: "default", name: "Main" }, { id: "room2", name: "Room 2" }]);
    try {
      assert.ok(two.container.querySelector('[aria-label="ProPresenter"]'), "no picker with two instances");
    } finally {
      two.restore();
    }
  });
});
