// The ProVideoPlayer "now" inspector rows: the Layout choice, which rows a layout
// greys out and says why, and what the Warn near the end thresholds write.
//
// Behaviour, not markup: what an operator sees disabled and what the caller is
// told. The thumbnails are drawn pictures and are looked at in a browser, not
// asserted here.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { PvpNowInspector } = await import("./inspector.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { LAYOUT_OBJECTS } = await import("../main/layout-objects.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

import type { LayoutObjectConfig } from "@main/types/views";

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

type Cfg = Extract<LayoutObjectConfig, { type: "pvp-now" }>;
const base = (over: Record<string, unknown> = {}): Cfg =>
  ({ ...LAYOUT_OBJECTS["pvp-now"].config(), ...over }) as Cfg;

async function mount(c: Cfg, onConfig: (c: LayoutObjectConfig) => void = () => {}) {
  render(React.createElement(TooltipProvider, null, React.createElement(PvpNowInspector, { c, pvp: null, onConfig })));
  await settle();
}

/** The row a label sits in — the switch, select or field beside it. */
const rowOf = (label: string): HTMLElement => {
  const row = screen.getByText(label).closest("div.flex.items-center");
  assert.ok(row, `no row labelled ${label}`);
  return row as HTMLElement;
};

describe("which rows a layout does not draw", () => {
  const has = (label: string) => screen.queryByRole("switch", { name: label }) !== null || screen.queryByRole("combobox", { name: label }) !== null;

  test("Countdown only: neither Next cue nor Label is drawn", async () => {
    await mount(base({ layout: "countdown" }));
    assert.equal(has("Next cue"), false, "Next cue is still drawn under Countdown only");
    assert.equal(has("Label"), false, "Label is still drawn under Countdown only");
  });

  test("Compact: Label is drawn, Next cue is not", async () => {
    await mount(base({ layout: "compact" }));
    assert.equal(has("Label"), true);
    assert.equal(has("Next cue"), false);
  });

  test("Full: Next cue is drawn, Label is not", async () => {
    await mount(base({ layout: "full" }));
    assert.equal(has("Next cue"), true);
    assert.equal(has("Label"), false);
  });

  test("a widget saved with the old Compact switch draws what Compact draws", async () => {
    await mount(base({ layout: undefined, compact: true }));
    assert.equal(has("Label"), true);
    assert.equal(has("Next cue"), false);
  });

  for (const layout of ["full", "compact", "countdown"] as const) {
    test(`Progress bar, Warn near the end and Count down stills stay drawn in ${layout}`, async () => {
      await mount(base({ layout }));
      assert.equal(has("Progress bar"), true);
      assert.equal(has("Count down stills"), true);
      assert.equal(has("Warn near the end"), true);
    });
  }
});

describe("the Layout choice", () => {
  test("three choices, the one in force pressed; the hint follows it", async () => {
    await mount(base({ layout: "countdown" }));
    const group = screen.getByRole("group", { name: "Layout" });
    const buttons = [...group.querySelectorAll("button")];
    assert.deepEqual(buttons.map((b) => [b.textContent, b.getAttribute("aria-pressed")]), [
      ["Full", "false"], ["Compact", "false"], ["Countdown only", "true"],
    ]);
    assert.ok(screen.getByText(/Only the time left, as large as the widget allows/));
  });

  test("a legacy compact: true widget shows Compact pressed", async () => {
    await mount(base({ layout: undefined, compact: true }));
    const pressed = [...screen.getByRole("group", { name: "Layout" }).querySelectorAll("button")]
      .filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);
    assert.deepEqual(pressed, ["Compact"]);
  });

  test("picking one writes layout and retires compact", async () => {
    const got: { c: Record<string, unknown> | null } = { c: null };
    await mount(base({ layout: undefined, compact: true }), (c) => { got.c = c as unknown as Record<string, unknown>; });
    fireEvent.click(screen.getByRole("button", { name: /Countdown only/ }));
    assert.ok(got.c, "nothing was written");
    assert.equal(got.c!.layout, "countdown");
    assert.equal(got.c!.compact, undefined);
  });
});

describe("Warn near the end", () => {
  test("the two thresholds appear only while it is on", async () => {
    await mount(base({ warnNearEnd: false }));
    assert.equal(screen.queryByText("Amber at"), null);
    assert.equal(screen.queryByText("Red at"), null);
    cleanup();
    await mount(base({ warnNearEnd: true }));
    assert.ok(screen.getByText("Amber at"));
    assert.ok(screen.getByText("Red at"));
  });

  test("they show 30 and 10 until set", async () => {
    await mount(base({ warnNearEnd: true, warnAmberSec: undefined, warnRedSec: undefined }));
    assert.equal((rowOf("Amber at").querySelector("input") as HTMLInputElement).value, "30");
    assert.equal((rowOf("Red at").querySelector("input") as HTMLInputElement).value, "10");
  });

  test("a red typed above the amber is held at the amber", async () => {
    const got: { c: Record<string, unknown> | null } = { c: null };
    await mount(base({ warnNearEnd: true, warnAmberSec: 30, warnRedSec: 10 }), (c) => { got.c = c as unknown as Record<string, unknown>; });
    fireEvent.change(rowOf("Red at").querySelector("input")!, { target: { value: "50" } });
    assert.ok(got.c, "nothing was written");
    assert.equal(got.c!.warnRedSec, 30, "red was stored above amber");
  });

  test("a stored red above the amber reads as the amber, and the stored number is left alone", async () => {
    let wrote = false;
    await mount(base({ warnNearEnd: true, warnAmberSec: 20, warnRedSec: 50 }), () => { wrote = true; });
    assert.equal((rowOf("Red at").querySelector("input") as HTMLInputElement).value, "20");
    assert.equal(wrote, false, "merely showing the row rewrote the config");
  });

  test("editing amber writes only the amber", async () => {
    const got: { c: Record<string, unknown> | null } = { c: null };
    await mount(base({ warnNearEnd: true, warnAmberSec: 30, warnRedSec: 10 }), (c) => { got.c = c as unknown as Record<string, unknown>; });
    fireEvent.change(rowOf("Amber at").querySelector("input")!, { target: { value: "45" } });
    assert.equal(got.c!.warnAmberSec, 45);
    assert.equal(got.c!.warnRedSec, 10, "typing an amber rewrote the red");
  });
});
