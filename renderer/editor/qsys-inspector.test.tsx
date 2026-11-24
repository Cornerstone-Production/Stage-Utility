// The Q-SYS inspector: what choosing, adding and switching mode does to an object's config.
//
// The Core browser's own filtering is pinned in qsys-core-browser.test.tsx; this is
// the half after it: a choice lands in the right field of the right object, a list
// never holds an empty row, and a switch of mode does not leave the other mode's
// bindings behind to be shadowed.
//
// Not unit-tested: how the blocks look in the inspector column (jsdom loads no
// stylesheet). That is checked in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installDom();

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { TooltipProvider } = await import("../components/ui/index.js");
const { QsysInspector } = await import("./qsys-inspector.js");
type QsysConfig = import("./qsys-inspector.js").QsysConfig;
type LayoutObjectConfig = import("@main/types/views").LayoutObjectConfig;

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const MIX = "Lobby_Mixer";
const CATALOG = {
  designCode: "d1",
  components: [
    {
      name: MIX,
      type: "mixer",
      controls: [
        { Name: "gain", Type: "Float", ValueMin: -100, ValueMax: 20 },
        { Name: "mute", Type: "Boolean" },
        { Name: "load_1", Type: "Trigger" },
        { Name: "load_2", Type: "Trigger" },
        { Name: "match_1", Type: "Boolean" },
        { Name: "zone_name", Type: "Text" },
        { Name: "meter_1", Type: "Float", ValueMin: -100, ValueMax: 20 },
      ],
    },
  ],
};
const allow = (control: string, min: number | null = null, max: number | null = null) => ({ component: MIX, control, label: "", min, max, confirm: "none" });
const ALLOW = { entries: [allow("gain", -100, 0), allow("mute"), allow("load_1"), allow("load_2")] };

const f = stubFetchWithLog((url) => {
  if (url === "/api/qsys/catalog") return ok(CATALOG);
  if (url === "/api/qsys/allowlist") return ok(ALLOW);
  throw new Error(`unexpected request ${url}`);
});
after(() => f.restore());

const wait = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

/** Mounts the inspector over a config it keeps, as the editor does; `latest()` is what it holds now. */
function mount(initial: QsysConfig) {
  let current: LayoutObjectConfig = initial;
  function Host() {
    const [c, setC] = React.useState<LayoutObjectConfig>(initial);
    current = c;
    return React.createElement(QsysInspector as never, { c, onConfig: (n: LayoutObjectConfig) => setC(n) } as never);
  }
  const r = render(React.createElement(TooltipProvider, null, React.createElement(Host)));
  return { ...r, latest: () => current as never as Record<string, unknown> };
}

async function choose(r: ReturnType<typeof mount>, opener: string | RegExp, control: string, index = 0) {
  fireEvent.click(r.getAllByRole("button", { name: opener })[index]!);
  await wait();
  fireEvent.click(r.getByRole("button", { name: new RegExp(`^${MIX}`) }));
  await wait();
  // A level row also says its range, after the name.
  fireEvent.click(r.getByRole("button", { name: new RegExp(`^${control}( |$)`) }));
  await wait();
}

const b = (control: string) => ({ component: MIX, control });

describe("the Q-SYS inspector", () => {
  test("every object type draws an inspector, the status object having nothing to set", () => {
    const configs: QsysConfig[] = [
      { type: "qsys-fader", binding: null, orientation: "vertical", showDb: true, steps: false, stepDb: 3 },
      { type: "qsys-meter", binding: null, form: "bar" },
      { type: "qsys-mute", binding: null },
      { type: "qsys-button", binding: null, label: "", hold: false },
      { type: "qsys-switch", binding: null, label: "" },
      { type: "qsys-presets", items: [] },
      { type: "qsys-selector", items: [] },
      { type: "qsys-label", binding: null, text: "" },
      { type: "qsys-strip", name: null, label: "", gain: null, mute: null, meter: null },
    ];
    for (const c of configs) {
      cleanup();
      const r = mount(c);
      assert.ok(r.container.querySelector("button"), `${c.type} drew no control`);
    }
    cleanup();
    assert.equal(mount({ type: "qsys-status" }).container.textContent, "");
  });

  test("a fader's level control lands in binding, and its step size shows only with step buttons", async () => {
    const r = mount({ type: "qsys-fader", binding: null, orientation: "vertical", showDb: true, steps: false, stepDb: 3 });
    assert.equal(r.queryByLabelText("Step size"), null);
    await choose(r, "Level control", "gain");
    assert.deepEqual(r.latest().binding, b("gain"));
    fireEvent.click(r.getByRole("switch", { name: "Step buttons" }));
    assert.ok(r.getByLabelText("Step size"), "step size appears with the step buttons");
    assert.equal(r.latest().steps, true);
  });

  test("a strip binds each part from its own kind of control", async () => {
    const r = mount({ type: "qsys-strip", name: null, label: "", gain: null, mute: null, meter: null });
    await choose(r, "Level", "gain");
    await choose(r, "Mute", "mute");
    await choose(r, "Meter", "meter_1");
    await choose(r, "Name", "zone_name");
    const s = r.latest();
    assert.deepEqual([s.gain, s.mute, s.meter, s.name], [b("gain"), b("mute"), b("meter_1"), b("zone_name")]);
  });

  test("adding a preset picks the control first and never adds an empty row", async () => {
    const r = mount({ type: "qsys-presets", items: [] });
    // Open the add browser and shut it without choosing: nothing is added.
    fireEvent.click(r.getByRole("button", { name: "Add preset" }));
    await wait();
    fireEvent.click(r.getByRole("button", { name: "Add preset" }));
    assert.deepEqual(r.latest().items, [], "opening and closing added a row");
    await choose(r, "Add preset", "load_1");
    assert.deepEqual(r.latest().items, [{ label: "load_1", binding: b("load_1") }]);
    await choose(r, "Add preset", "load_2");
    assert.deepEqual((r.latest().items as { label: string }[]).map((i) => i.label), ["load_1", "load_2"]);
    // A preset's label is the operator's to rename.
    fireEvent.change(r.getAllByLabelText("Label")[0]!, { target: { value: "Full band" } });
    assert.equal((r.latest().items as { label: string }[])[0]!.label, "Full band");
    fireEvent.click(r.getByRole("button", { name: "Remove Full band" }));
    assert.deepEqual((r.latest().items as { label: string }[]).map((i) => i.label), ["load_2"]);
  });

  test("a preset's lamp control is kept when its control is changed", async () => {
    const r = mount({ type: "qsys-presets", items: [{ label: "One", binding: { ...b("load_1"), indicator: b("match_1") } }] });
    await choose(r, "Control", "load_2");
    assert.deepEqual((r.latest().items as { binding: unknown }[])[0]!.binding, { ...b("load_2"), indicator: b("match_1") });
  });

  test("a switch changing mode clears the other mode's controls", async () => {
    const r = mount({ type: "qsys-switch", binding: b("mute"), label: "Mute" });
    fireEvent.click(r.getByRole("button", { name: "On and off" }));
    await wait();
    const s = r.latest();
    assert.equal(s.binding, null, "the single control would shadow the pair");
    await choose(r, "On trigger", "load_1");
    await choose(r, "Off trigger", "load_2");
    assert.deepEqual([r.latest().onBinding, r.latest().offBinding], [b("load_1"), b("load_2")]);
    fireEvent.click(r.getByRole("button", { name: "One control" }));
    await wait();
    assert.deepEqual([r.latest().onBinding, r.latest().offBinding], [null, null]);
  });

  test("a button's control type decides which controls it is offered", async () => {
    const r = mount({ type: "qsys-button", binding: null, label: "", hold: false });
    await choose(r, "Control", "load_1");
    assert.deepEqual(r.latest().binding, b("load_1"));
  });

  test("a label's text control and its own text are separate fields", async () => {
    const r = mount({ type: "qsys-label", binding: null, text: "" });
    await choose(r, "Text control", "zone_name");
    fireEvent.change(r.getByLabelText("Text"), { target: { value: "Zone 1" } });
    assert.deepEqual([r.latest().binding, r.latest().text], [b("zone_name"), "Zone 1"]);
  });
});
