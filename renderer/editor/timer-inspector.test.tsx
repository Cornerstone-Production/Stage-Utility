// The Timer's inspector: the controls the approved mockup shows for each source,
// and that each one writes the field it names.
//
// Driven through the real Inspector, not TimerInspector alone, because the part
// that matters most is upstream of it: an object saved as one of the four retired
// timers has to open here AS a Timer, and a control that renders is not a
// control that writes the right key.
//
// NOT covered: the stacked layout and the three-segment Source control's look.
// jsdom loads no stylesheet, so those were checked in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { settle, installRenderDom, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { Inspector } = await import("./inspector.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { DEFAULT_STAGE_STATE } = await import("../main/test-render-ctx.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** Mounts the Inspector on one object and returns what it is asked to write. */
async function mount(config: Record<string, unknown>, timers = [{ name: "Stage timer", time: "00:03:00", state: "running" }, { name: "Sermon", time: "00:20:00", state: "running" }]) {
  const f = stubFetchWithLog((url) =>
    url.endsWith("/api/state") ? ok(DEFAULT_STAGE_STATE)
    : url.includes("/api/propresenter/instances")
      ? ok({
          list: [{ id: "default", name: "Main" }],
          conn: {},
          status: { default: { connected: true, timers } },
        })
      : ok({}),
  );
  const writes: LayoutObjectConfig[] = [];
  const o = { id: "t1", x: 0.1, y: 0.1, w: 0.5, h: 0.5, z: 0, config } as LayoutObject;
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

const labelsIn = (root: HTMLElement) => new Set([...root.querySelectorAll("[aria-label], span")].map((e) => e.getAttribute("aria-label") ?? e.textContent ?? ""));

describe("what each source shows", () => {
  test("Service: the next item, the caption and sub-line, and the warning settings", async () => {
    const m = await mount({ type: "timer", source: "service", warnSeconds: 60 });
    try {
      for (const l of ["Source", "Show the next item", "Caption", "Show the sub-line", "Hide when idle", "Amber near the end", "Warn at (seconds left)", "Red on overrun"]) {
        assert.ok(labelsIn(m.container).has(l), `Service is missing "${l}"`);
      }
      assert.equal(m.container.querySelector('[aria-label="Shows"]'), null, "Service offers the baptism picker");
      assert.equal(m.container.querySelector('[aria-label="Timer"]'), null, "Service offers the ProPresenter picker");
    } finally {
      m.restore();
    }
  });

  test("ProPresenter: a Timer picker of the running timers, and the timer's name for the sub-line", async () => {
    const m = await mount({ type: "timer", source: "propresenter" });
    try {
      for (const l of ["Timer", "Show the timer’s name", "Hide when idle", "Amber near the end", "Red on overrun"]) {
        assert.ok(labelsIn(m.container).has(l), `ProPresenter is missing "${l}"`);
      }
      assert.ok(!labelsIn(m.container).has("Show the next item"));
      assert.equal(m.container.querySelector('[aria-label="Warn at (seconds left)"]'), null, "Warn at shows with Amber off");
    } finally {
      m.restore();
    }
  });

  test("Baptism: the nine readouts, and a sentence in place of the warning settings", async () => {
    const m = await mount({ type: "timer", source: "baptism" });
    try {
      assert.ok(m.container.querySelector('[aria-label="Shows"]'), "Baptism is missing its readout picker");
      assert.ok(labelsIn(m.container).has("Show the label"));
      assert.ok(!labelsIn(m.container).has("Amber near the end"));
      assert.ok(!labelsIn(m.container).has("Red on overrun"));
      assert.match(m.container.textContent ?? "", /Baptism clocks count up from zero, so there is no end to warn about\./);
    } finally {
      m.restore();
    }
  });
});

describe("each control writes the field it names", () => {
  const sw = (m: { getByRole: (r: string, o: { name: string }) => HTMLElement }, name: string) => m.getByRole("switch", { name });

  test("Source switches and keeps every other setting", async () => {
    const m = await mount({ type: "timer", source: "service", caption: "Time left", warnSeconds: 45 });
    try {
      fireEvent.click(m.getByRole("button", { name: "Baptism" }));
      assert.deepEqual(m.writes.at(-1), { type: "timer", source: "baptism", caption: "Time left", warnSeconds: 45 });
    } finally {
      m.restore();
    }
  });

  test("Show the next item", async () => {
    const m = await mount({ type: "timer", source: "service" });
    try {
      fireEvent.click(sw(m, "Show the next item"));
      assert.deepEqual(m.writes.at(-1), { type: "timer", source: "service", nextItem: true });
    } finally {
      m.restore();
    }
  });

  test("Amber near the end writes 60, and off removes it", async () => {
    const m = await mount({ type: "timer", source: "service" });
    try {
      fireEvent.click(sw(m, "Amber near the end"));
      assert.equal((m.writes.at(-1) as { warnSeconds?: number }).warnSeconds, 60);
    } finally {
      m.restore();
    }
    cleanup();
    const on = await mount({ type: "timer", source: "service", warnSeconds: 60 });
    try {
      fireEvent.click(sw(on, "Amber near the end"));
      assert.equal((on.writes.at(-1) as { warnSeconds?: number }).warnSeconds, undefined);
    } finally {
      on.restore();
    }
  });

  test("Warn at is the themed number field and writes as you type", async () => {
    const m = await mount({ type: "timer", source: "service", warnSeconds: 60 });
    try {
      const field = m.container.querySelector('[aria-label="Warn at (seconds left)"]') as HTMLInputElement;
      assert.ok(field, "no Warn at field");
      assert.notEqual(field.getAttribute("type"), "number", "a raw number input: the app's NumberInput is the convention");
      fireEvent.change(field, { target: { value: "90" } });
      assert.equal((m.writes.at(-1) as { warnSeconds?: number }).warnSeconds, 90);
    } finally {
      m.restore();
    }
  });

  test("Red on overrun, Hide when idle and the sub-line switch", async () => {
    const m = await mount({ type: "timer", source: "service" });
    try {
      assert.equal(sw(m, "Red on overrun").getAttribute("aria-checked"), "true", "defaults on");
      fireEvent.click(sw(m, "Red on overrun"));
      assert.equal((m.writes.at(-1) as { redOnOverrun?: boolean }).redOnOverrun, false);
      fireEvent.click(sw(m, "Hide when idle"));
      assert.equal((m.writes.at(-1) as { hideWhenIdle?: boolean }).hideWhenIdle, true);
      fireEvent.click(sw(m, "Show the sub-line"));
      assert.equal((m.writes.at(-1) as { showLabel?: boolean }).showLabel, false);
    } finally {
      m.restore();
    }
  });

  test("Caption writes what is typed, and clearing it writes an empty caption: none", async () => {
    const m = await mount({ type: "timer", source: "service", caption: "Time left" });
    try {
      const caption = m.container.querySelector('[aria-label="Caption"]') as HTMLInputElement;
      assert.equal(caption.value, "Time left");
      fireEvent.change(caption, { target: { value: "" } });
      assert.equal((m.writes.at(-1) as { caption?: string }).caption, "");
    } finally {
      m.restore();
    }
  });

  test("the placeholder says what an empty caption draws", async () => {
    const unset = await mount({ type: "timer", source: "service" });
    try {
      assert.equal((unset.container.querySelector('[aria-label="Caption"]') as HTMLInputElement).placeholder, "The item\u2019s name");
    } finally {
      unset.restore();
    }
    cleanup();
    const cleared = await mount({ type: "timer", source: "service", caption: "" });
    try {
      assert.equal((cleared.container.querySelector('[aria-label="Caption"]') as HTMLInputElement).placeholder, "No caption");
    } finally {
      cleared.restore();
    }
  });

  test("switching source swaps the caption while it is still the old source's default", async () => {
    const m = await mount({ type: "timer", source: "service" });
    try {
      fireEvent.click(m.getByRole("button", { name: "ProPresenter" }));
      assert.deepEqual(m.writes.at(-1), { type: "timer", source: "propresenter", caption: "Stage timer" });
    } finally {
      m.restore();
    }
  });
});

describe("a retired timer opens as a Timer", () => {
  test("a saved PCO countdown shows the Timer's controls, and the first edit writes a Timer", async () => {
    const m = await mount({ type: "countdown-timer", warnSeconds: 45, caption: "Time left" });
    try {
      assert.ok(labelsIn(m.container).has("Source"), "the Timer's Source control is missing");
      assert.ok(labelsIn(m.container).has("Show the next item"));
      assert.ok(!/This object has been replaced/.test(m.container.textContent ?? ""), "it still offers a Convert button");
      fireEvent.click(m.getByRole("switch", { name: "Hide when idle" }));
      assert.deepEqual(m.writes.at(-1), {
        type: "timer", source: "service", nextItem: false, redOnOverrun: true, warnSeconds: 45, caption: "Time left", hideWhenIdle: true,
      });
    } finally {
      m.restore();
    }
  });

  test("a saved Baptism timer opens on the Baptism source with its readout", async () => {
    const m = await mount({ type: "baptism-timer", field: "session", showLabel: true, caption: "Baptisms" });
    try {
      assert.ok(m.container.querySelector('[aria-label="Shows"]'), "the baptism readout picker is missing");
      assert.match(m.container.textContent ?? "", /Baptism clocks count up/);
    } finally {
      m.restore();
    }
  });
});

describe("the ProPresenter timer name", () => {
  // Always a text field, so a name can be typed before the service when nothing is
  // running. The reported timers are suggestions in a datalist.
  test("is a text field that suggests the running timers and writes what is typed", async () => {
    const m = await mount({ type: "timer", source: "propresenter" });
    try {
      const field = m.container.querySelector('[aria-label="Timer"]') as HTMLInputElement;
      assert.equal(field.tagName, "INPUT");
      assert.match(field.placeholder, /first running timer/);
      const list = m.container.querySelector(`datalist#${field.getAttribute("list")}`);
      await new Promise((r) => setTimeout(r, 50));
      const offered = [...(list?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value"));
      assert.deepEqual(offered, ["Stage timer", "Sermon"]);
      fireEvent.change(field, { target: { value: "Countdown" } });
      assert.equal((m.writes.at(-1) as { timerName?: string | null }).timerName, "Countdown");
    } finally {
      m.restore();
    }
  });

  test("a name of two words can be typed, and is trimmed when the field is left", async () => {
    const m = await mount({ type: "timer", source: "propresenter" });
    try {
      const field = m.container.querySelector('[aria-label="Timer"]') as HTMLInputElement;
      fireEvent.change(field, { target: { value: "Stage " } });
      assert.equal((m.writes.at(-1) as { timerName?: string | null }).timerName, "Stage ", "the space typed after the first word was dropped");
      fireEvent.blur(field, { target: { value: "  Stage timer  " } });
      assert.equal((m.writes.at(-1) as { timerName?: string | null }).timerName, "Stage timer");
    } finally {
      m.restore();
    }
  });

  test("an empty field follows the first running timer: clearing writes null", async () => {
    const m = await mount({ type: "timer", source: "propresenter", timerName: "Sermon" });
    try {
      fireEvent.change(m.container.querySelector('[aria-label="Timer"]') as HTMLInputElement, { target: { value: "" } });
      assert.equal((m.writes.at(-1) as { timerName?: string | null }).timerName, null);
    } finally {
      m.restore();
    }
  });

  test("is still a text field when nothing is running", async () => {
    const m = await mount({ type: "timer", source: "propresenter" }, []);
    try {
      const field = m.container.querySelector('[aria-label="Timer"]') as HTMLInputElement;
      assert.equal(field.tagName, "INPUT");
      fireEvent.change(field, { target: { value: "Sermon" } });
      assert.equal((m.writes.at(-1) as { timerName?: string | null }).timerName, "Sermon");
    } finally {
      m.restore();
    }
  });
});
