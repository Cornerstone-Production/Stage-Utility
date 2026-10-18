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
const switchIn = (label: string) => rowOf(label).querySelector("button[role=switch]") as HTMLButtonElement;
const selectIn = (label: string) => rowOf(label).querySelector("select") as HTMLSelectElement;
const reasons = (text: string) => screen.queryAllByText(text).length;

describe("which rows a layout greys out, and why", () => {
  test("Countdown only: Next cue and Label are disabled, each saying so", async () => {
    await mount(base({ layout: "countdown" }));
    assert.equal(switchIn("Next cue").disabled, true, "Next cue is still live under Countdown only");
    assert.equal(selectIn("Label").disabled, true, "Label is still live under Countdown only");
    assert.equal(reasons("Not shown in Countdown only."), 2);
  });

  test("Compact: Label is live, Next cue is not", async () => {
    await mount(base({ layout: "compact" }));
    assert.equal(selectIn("Label").disabled, false);
    assert.equal(switchIn("Next cue").disabled, true);
    assert.equal(reasons("Not shown in Compact."), 1);
  });

  test("Full: Next cue is live, Label is not", async () => {
    await mount(base({ layout: "full" }));
    assert.equal(switchIn("Next cue").disabled, false);
    assert.equal(selectIn("Label").disabled, true);
  });

  test("a widget saved with the old Compact switch greys what Compact greys", async () => {
    await mount(base({ layout: undefined, compact: true }));
    assert.equal(selectIn("Label").disabled, false);
    assert.equal(switchIn("Next cue").disabled, true);
  });

  test("Progress bar, Warn near the end and Count down stills stay live in every layout", async () => {
    await mount(base({ layout: "countdown" }));
    assert.equal(switchIn("Progress bar").disabled, false);
    assert.equal(switchIn("Count down stills").disabled, false);
    assert.equal(switchIn("Warn near the end").disabled, false);
  });
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
    assert.equal(screen.queryByText("Amber from (seconds left)"), null);
    assert.equal(screen.queryByText("Red from (seconds left)"), null);
    cleanup();
    await mount(base({ warnNearEnd: true }));
    assert.ok(screen.getByText("Amber from (seconds left)"));
    assert.ok(screen.getByText("Red from (seconds left)"));
  });

  test("they show 30 and 10 until set", async () => {
    await mount(base({ warnNearEnd: true, warnAmberSec: undefined, warnRedSec: undefined }));
    assert.equal((rowOf("Amber from (seconds left)").querySelector("input") as HTMLInputElement).value, "30");
    assert.equal((rowOf("Red from (seconds left)").querySelector("input") as HTMLInputElement).value, "10");
  });

  test("a red typed above the amber is held at the amber", async () => {
    const got: { c: Record<string, unknown> | null } = { c: null };
    await mount(base({ warnNearEnd: true, warnAmberSec: 30, warnRedSec: 10 }), (c) => { got.c = c as unknown as Record<string, unknown>; });
    fireEvent.change(rowOf("Red from (seconds left)").querySelector("input")!, { target: { value: "50" } });
    assert.ok(got.c, "nothing was written");
    assert.equal(got.c!.warnRedSec, 30, "red was stored above amber");
  });

  test("a stored red above the amber reads as the amber, and the stored number is left alone", async () => {
    let wrote = false;
    await mount(base({ warnNearEnd: true, warnAmberSec: 20, warnRedSec: 50 }), () => { wrote = true; });
    assert.equal((rowOf("Red from (seconds left)").querySelector("input") as HTMLInputElement).value, "20");
    assert.equal(wrote, false, "merely showing the row rewrote the config");
  });

  test("editing amber writes only the amber", async () => {
    const got: { c: Record<string, unknown> | null } = { c: null };
    await mount(base({ warnNearEnd: true, warnAmberSec: 30, warnRedSec: 10 }), (c) => { got.c = c as unknown as Record<string, unknown>; });
    fireEvent.change(rowOf("Amber from (seconds left)").querySelector("input")!, { target: { value: "45" } });
    assert.equal(got.c!.warnAmberSec, 45);
    assert.equal(got.c!.warnRedSec, 10, "typing an amber rewrote the red");
  });
});
