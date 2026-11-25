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
afterEach(() => {
  cleanup();
  withChoices = false;
});

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
        { Name: "load.1", Type: "Trigger" },
        { Name: "load.2", Type: "Trigger" },
        { Name: "match.1", Type: "Boolean" },
        { Name: "zone_name", Type: "Text" },
        { Name: "meter.1", Type: "Float", ValueMin: -100, ValueMax: 20 },
      ],
    },
    {
      name: "Input_Bank",
      type: "mixer",
      controls: [
        { Name: "input.3.gain", Type: "Float", ValueMin: -100, ValueMax: 20 },
        { Name: "input.3.mute", Type: "Boolean" },
        { Name: "meter.3", Type: "Float", ValueMin: -100, ValueMax: 20, Direction: "Read" },
        { Name: "text.display.3", Type: "Text", Direction: "Read" },
        { Name: "input.4.gain", Type: "Float", ValueMin: -100, ValueMax: 20 },
        { Name: "input.4.mute", Type: "Boolean" },
      ],
    },
  ],
};
/** What the next catalog read answers: tests add a control that carries Choices. */
let withChoices = false;
const allow = (control: string, min: number | null = null, max: number | null = null) => ({ component: MIX, control, label: "", min, max, confirm: "none" });
const bank = (control: string, min: number | null = null, max: number | null = null) => ({ component: "Input_Bank", control, label: "", min, max, confirm: "none" });
// input.4.mute is deliberately not allowlisted.
const ALLOW = { entries: [allow("gain", -100, 0), allow("mute"), allow("load.1"), allow("load.2"), bank("input.3.gain", -100, 0), bank("input.3.mute"), bank("input.4.gain", -100, 0)] };

const f = stubFetchWithLog((url) => {
  if (url === "/api/qsys/catalog") {
    if (!withChoices) return ok(CATALOG);
    return ok({ ...CATALOG, components: [{ ...CATALOG.components[0], controls: [...CATALOG.components[0]!.controls, { Name: "source", Type: "Text", Choices: ["Mic", "Laptop"] }] }, ...CATALOG.components.slice(1)] });
  }
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
    await choose(r, "Meter", "meter.1");
    await choose(r, "Name", "zone_name");
    const s = r.latest();
    assert.deepEqual([s.gain, s.mute, s.meter, s.name], [b("gain"), b("mute"), b("meter.1"), b("zone_name")]);
  });

  test("adding a preset picks the control first and never adds an empty row", async () => {
    const r = mount({ type: "qsys-presets", items: [] });
    // Open the add browser and shut it without choosing: nothing is added.
    fireEvent.click(r.getByRole("button", { name: "Add preset" }));
    await wait();
    fireEvent.click(r.getByRole("button", { name: "Add preset" }));
    assert.deepEqual(r.latest().items, [], "opening and closing added a row");
    await choose(r, "Add preset", "load.1");
    assert.deepEqual(r.latest().items, [{ label: "load.1", binding: b("load.1") }]);
    await choose(r, "Add preset", "load.2");
    assert.deepEqual((r.latest().items as { label: string }[]).map((i) => i.label), ["load.1", "load.2"]);
    // A preset's label is the operator's to rename.
    fireEvent.change(r.getAllByLabelText("Label")[0]!, { target: { value: "Full band" } });
    assert.equal((r.latest().items as { label: string }[])[0]!.label, "Full band");
    fireEvent.click(r.getByRole("button", { name: "Remove Full band" }));
    assert.deepEqual((r.latest().items as { label: string }[]).map((i) => i.label), ["load.2"]);
  });

  test("a preset's lamp control is kept when its control is changed", async () => {
    const r = mount({ type: "qsys-presets", items: [{ label: "One", binding: { ...b("load.1"), indicator: b("match.1") } }] });
    await choose(r, "Control", "load.2");
    assert.deepEqual((r.latest().items as { binding: unknown }[])[0]!.binding, { ...b("load.2"), indicator: b("match.1") });
  });

  test("a switch changing mode clears the other mode's controls", async () => {
    const r = mount({ type: "qsys-switch", binding: b("mute"), label: "Mute" });
    fireEvent.click(r.getByRole("button", { name: "On and off" }));
    await wait();
    const s = r.latest();
    assert.equal(s.binding, null, "the single control would shadow the pair");
    await choose(r, "On trigger", "load.1");
    await choose(r, "Off trigger", "load.2");
    assert.deepEqual([r.latest().onBinding, r.latest().offBinding], [b("load.1"), b("load.2")]);
    fireEvent.click(r.getByRole("button", { name: "One control" }));
    await wait();
    assert.deepEqual([r.latest().onBinding, r.latest().offBinding], [null, null]);
  });

  test("a button's control type decides which controls it is offered", async () => {
    const r = mount({ type: "qsys-button", binding: null, label: "", hold: false });
    await choose(r, "Control", "load.1");
    assert.deepEqual(r.latest().binding, b("load.1"));
  });

  test("a label's text control and its own text are separate fields", async () => {
    const r = mount({ type: "qsys-label", binding: null, text: "" });
    await choose(r, "Text control", "zone_name");
    fireEvent.change(r.getByLabelText("Text"), { target: { value: "Zone 1" } });
    assert.deepEqual([r.latest().binding, r.latest().text], [b("zone_name"), "Zone 1"]);
  });

  test("a button's Trigger or Momentary type is saved on the object, and a saved momentary reopens as one", async () => {
    const r = mount({ type: "qsys-button", binding: null, label: "", hold: false });
    fireEvent.click(r.getByRole("button", { name: "Momentary" }));
    await wait();
    assert.equal(r.latest().press, "momentary");
    await choose(r, "Control", "mute");
    assert.deepEqual(r.latest().binding, b("mute"), "a momentary is offered on and off controls");
    cleanup();
    const again = mount({ type: "qsys-button", binding: b("mute"), label: "", hold: false, press: "momentary" });
    assert.equal(again.getByRole("button", { name: "Momentary" }).getAttribute("aria-pressed") ?? again.getByRole("button", { name: "Momentary" }).getAttribute("aria-checked"), "true");
    fireEvent.click(again.getByRole("button", { name: "Trigger" }));
    await wait();
    assert.equal(again.latest().press, undefined, "trigger is the absence of the field");
    assert.equal(again.latest().binding, null, "a boolean is not a trigger: the binding is cleared");
  });

  test("a selector offers the choice list only where the Core reports Choices", async () => {
    let r = mount({ type: "qsys-selector", items: [] });
    await wait();
    assert.equal(r.queryByRole("button", { name: "Choice list" }), null, "no Choices on this Core, so no choice-list mode");
    assert.ok(r.getByRole("button", { name: "Add button" }), "the set of triggers is always there");
    cleanup();
    withChoices = true;
    r = mount({ type: "qsys-selector", items: [] });
    await wait();
    assert.ok(r.getByRole("button", { name: "Choice list" }));
    cleanup();
    withChoices = false;
    r = mount({ type: "qsys-selector", binding: b("source"), items: [] });
    await wait();
    assert.ok(r.getByRole("button", { name: "Choice list" }), "an existing choice binding stays visible so it can be cleared");
  });

  test("Bind a channel fills the strip from one component's names, allowlisted writes only, and says why a slot is empty", async () => {
    const r = mount({ type: "qsys-strip", name: null, label: "", gain: null, mute: null, meter: null });
    fireEvent.click(r.getByRole("button", { name: "Bind a channel" }));
    await wait();
    const select = r.getByLabelText("Component") as HTMLSelectElement;
    assert.deepEqual([...select.options].map((o) => o.value), ["", "Lobby_Mixer", "Input_Bank"], "only components with channel-named controls (meter.1 alone makes one)");
    fireEvent.change(select, { target: { value: "Input_Bank" } });
    await wait();
    fireEvent.click(r.getByRole("button", { name: "Input 4" }));
    await wait();
    const four = r.latest() as Record<string, unknown>;
    const ib = (control: string) => ({ component: "Input_Bank", control });
    assert.deepEqual([four.gain, four.mute, four.meter, four.name], [ib("input.4.gain"), null, null, null]);
    const notes = r.container.querySelector("[data-qsys-fill-notes]")!.textContent ?? "";
    assert.match(notes, /mute control is not on the allowlist/);
    assert.match(notes, /No meter control found/);
    fireEvent.click(r.getByRole("button", { name: "Input 3" }));
    await wait();
    const three = r.latest() as Record<string, unknown>;
    assert.deepEqual([three.gain, three.mute, three.meter, three.name], [ib("input.3.gain"), ib("input.3.mute"), ib("meter.3"), ib("text.display.3")]);
    assert.equal(r.container.querySelector("[data-qsys-fill-notes]"), null, "nothing to explain");
    // Any field can be changed afterwards.
    await choose(r, "Mute", "mute");
    assert.deepEqual((r.latest() as Record<string, unknown>).mute, b("mute"));
  });

  test("Break apart is offered on a strip and calls the editor's action", () => {
    let called = 0;
    const r = render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(QsysInspector as never, { c: { type: "qsys-strip", name: null, label: "", gain: null, mute: null, meter: null }, onConfig: () => {}, onBreakApart: () => called++ } as never),
      ),
    );
    fireEvent.click(r.getByRole("button", { name: "Break apart" }));
    assert.equal(called, 1);
  });
});
