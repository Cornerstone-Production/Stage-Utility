// The Core browser: pick the control a Q-SYS object binds to.
//
// What these pin is what is OFFERED, since offering a control an object cannot
// use is how an operator binds something the panel then draws as Unavailable:
//   - an object that writes only sees allowlisted controls the writer would
//     accept (not read-only, and a numeric one has write limits);
//   - an object that only reads sees every control of the right kind;
//   - with no Core connected it says so and lists nothing, never a made-up list.
//
// Not unit-tested: how the browser looks in the inspector's narrow column (jsdom
// loads no stylesheet and lays nothing out). That is checked in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installDom();

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { TooltipProvider } = await import("../components/ui/index.js");
const { QsysCoreBrowser, fitsKind } = await import("./qsys-core-browser.js");
type Binding = import("@main/types/qsys").QsysBinding;
type Props = import("react").ComponentProps<typeof QsysCoreBrowser>;

after(() => unmountAndTeardown(cleanup, teardown));

const MIX = "Lobby_Mixer";
const AMP = "Zone_Amp";

const CATALOG = {
  designCode: "d1",
  components: [
    {
      name: MIX,
      type: "mixer",
      controls: [
        { Name: "gain", Type: "Float", ValueMin: -100, ValueMax: 20 },
        // On the Core, not on the allowlist.
        { Name: "gain_free", Type: "Float", ValueMin: -100, ValueMax: 20 },
        // On the allowlist, but the Core says it is read-only.
        { Name: "gain_ro", Type: "Float", Direction: "Read", ValueMin: -100, ValueMax: 20 },
        // On the allowlist, numeric, but with no write limits set.
        { Name: "gain_nolimit", Type: "Float", ValueMin: -100, ValueMax: 20 },
        // A number the Core reports no range for.
        { Name: "trim", Type: "Float" },
        { Name: "mute", Type: "Boolean" },
        { Name: "mute_free", Type: "Boolean" },
        { Name: "mute_ro", Type: "Boolean", Direction: "Read" },
        { Name: "load.1", Type: "Trigger" },
        { Name: "zone_name", Type: "Text" },
        { Name: "source", Type: "Text", Choices: ["Mic", "Laptop"] },
        { Name: "meter.1", Type: "Float", ValueMin: -100, ValueMax: 20 },
      ],
    },
    {
      name: AMP,
      type: "amplifier",
      controls: [
        { Name: "output", Type: "Float", ValueMin: -60, ValueMax: 0 },
        { Name: "standby", Type: "Boolean" },
      ],
    },
    { name: "Empty_Comp", type: "other", controls: [{ Name: "note", Type: "Text" }] },
  ],
};

const entry = (component: string, control: string, min: number | null, max: number | null) => ({ component, control, label: "", min, max, confirm: "none" });
const ALLOW = {
  entries: [
    entry(MIX, "gain", -100, 0),
    entry(MIX, "gain_ro", -100, 0),
    entry(MIX, "gain_nolimit", null, null),
    entry(MIX, "trim", -10, 10),
    entry(MIX, "mute", null, null),
    entry(MIX, "mute_ro", null, null),
    entry(MIX, "load.1", null, null),
    entry(MIX, "source", null, null),
    entry(AMP, "output", -60, 0),
  ],
};

interface Server {
  catalog: () => ReturnType<typeof ok>;
  allowlist: () => ReturnType<typeof ok>;
  reads: string[];
}
let server: Server;

const f = stubFetchWithLog((url) => {
  server.reads.push(url);
  if (url === "/api/qsys/catalog") return server.catalog();
  if (url === "/api/qsys/allowlist") return server.allowlist();
  throw new Error(`unexpected request ${url}`);
});
after(() => f.restore());

beforeEach(() => {
  server = { catalog: () => ok(CATALOG), allowlist: () => ok(ALLOW), reads: [] };
  f.logs.length = 0;
});
afterEach(() => cleanup());

/** The app's root provides the tooltips the Clear button's icon wants. */
const mountBrowser = (props: Props) => render(React.createElement(TooltipProvider, null, React.createElement(QsysCoreBrowser as never, props as never)));

const wait = (ms = 20) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

async function open(props: Partial<Props> & Pick<Props, "kind" | "writable">) {
  const changes: (Binding | null)[] = [];
  const r = mountBrowser({ value: null, onChange: (b: Binding | null) => changes.push(b), ...props } as Props);
  fireEvent.click(r.getByRole("button", { name: "Control" }));
  await wait();
  return { ...r, changes };
}

const attrs = (container: HTMLElement, attr: string) => [...container.querySelectorAll(`[${attr}]`)].map((n) => n.getAttribute(attr)!);
/** The controls and components listed, by name. */
const controls = (c: HTMLElement) => attrs(c, "data-qsys-control");
const components = (c: HTMLElement) => attrs(c, "data-qsys-component");

async function into(r: Awaited<ReturnType<typeof open>>, component: string) {
  fireEvent.click(r.getByRole("button", { name: new RegExp(`^${component}`) }));
  await wait();
}

describe("the Core browser", () => {
  test("lists components, then controls filtered by kind", async () => {
    const r = await open({ kind: "boolean", writable: false });
    // Only components with a boolean control are listed, in the Core's order.
    assert.deepEqual(components(r.container), [MIX, AMP], "Empty_Comp has no boolean and must not be offered");
    await into(r, MIX);
    assert.deepEqual(controls(r.container), ["mute", "mute_free", "mute_ro"], "booleans only");
    fireEvent.click(r.getByRole("button", { name: /^Components/ }));
    await wait();
    assert.deepEqual(components(r.container), [MIX, AMP], "back to the components");
  });

  test("each kind offers what fits it", async () => {
    const cases: [Props["kind"], string[]][] = [
      // numeric with a range from the Core, not a meter
      ["gain", ["gain", "gain_free", "gain_nolimit", "gain_ro"]],
      ["trigger", ["load.1"]],
      // a selector's button: a trigger, or an on/off control
      ["press", ["load.1", "mute", "mute_free", "mute_ro"]],
      ["string", ["source", "zone_name"]],
      ["choice", ["source"]],
      ["meter", ["meter.1"]],
    ];
    for (const [kind, expected] of cases) {
      cleanup();
      const r = await open({ kind, writable: false });
      await into(r, MIX);
      assert.deepEqual(controls(r.container), expected, `kind ${kind}`);
    }
  });

  test("a meter component's settings are not levels: a meter2's hold.time is offered to nothing that draws a level", () => {
    const numeric = (Name: string) => ({ Name, Type: "Float", ValueMin: 0, ValueMax: 10 });
    assert.equal(fitsKind("gain", "meter2", numeric("hold.time")), false, "a meter2's hold.time is offered as a fader");
    assert.equal(fitsKind("meter", "meter2", numeric("hold.time")), false, "a meter2's hold.time is offered as a meter");
    assert.equal(fitsKind("meter", "meter2", numeric("meter.1")), true);
    assert.equal(fitsKind("gain", "mixer", numeric("output.1.gain")), true);
  });

  test("a writable object only offers allowlisted controls; read-only objects offer all", async () => {
    const w = await open({ kind: "gain", writable: true });
    await into(w, MIX);
    assert.deepEqual(controls(w.container), ["gain"], "not allowlisted, read-only and no-write-limits are all refused");
    fireEvent.click(w.getByRole("button", { name: /^Components/ }));
    await wait();
    assert.deepEqual(components(w.container), [MIX, AMP], "Zone_Amp's allowlisted output is writable");
    cleanup();

    const wb = await open({ kind: "boolean", writable: true });
    await into(wb, MIX);
    assert.deepEqual(controls(wb.container), ["mute"], "mute_free is not allowlisted and mute_ro is read-only");
    cleanup();

    const ro = await open({ kind: "gain", writable: false });
    await into(ro, MIX);
    assert.deepEqual(controls(ro.container), ["gain", "gain_free", "gain_nolimit", "gain_ro"], "a read object needs no allowlist");
  });

  test("a numeric control that lists choices and has no write limits is offered to a choice list, not to a fader", async () => {
    const ROUTER = "Router";
    server.catalog = () =>
      ok({ ...CATALOG, components: [...CATALOG.components, { name: ROUTER, type: "router", controls: [{ Name: "src", Type: "Float", ValueMin: 0, ValueMax: 3, Choices: ["Mic", "Laptop"] }] }] });
    server.allowlist = () => ok({ entries: [...ALLOW.entries, entry(ROUTER, "src", null, null)] });
    const choice = await open({ kind: "choice", writable: true });
    assert.ok(components(choice.container).includes(ROUTER), "a choice list was not offered the control its choices bound");
    await into(choice, ROUTER);
    assert.deepEqual(controls(choice.container), ["src"]);
    cleanup();
    const gain = await open({ kind: "gain", writable: true });
    assert.ok(!components(gain.container).includes(ROUTER), "a fader was offered a numeric control with no write limits");
  });

  test("search filters by component and control name", async () => {
    const r = await open({ kind: "boolean", writable: false });
    const search = r.getByLabelText("Search controls") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "standby" } });
    await wait();
    assert.deepEqual(controls(r.container), ["standby"], "a control name finds the control from the component list");
    fireEvent.change(search, { target: { value: "lobby" } });
    await wait();
    assert.deepEqual(controls(r.container), ["mute", "mute_free", "mute_ro"], "a component name finds its controls, case aside");
    fireEvent.change(search, { target: { value: "zzz" } });
    await wait();
    assert.deepEqual(controls(r.container), []);
    assert.match(r.container.textContent ?? "", /Nothing matches/);
  });

  test("choosing a control reports the binding, and clearing reports null", async () => {
    const r = await open({ kind: "boolean", writable: true });
    await into(r, MIX);
    fireEvent.click(r.getByRole("button", { name: "mute" }));
    await wait();
    assert.deepEqual(r.changes, [{ component: MIX, control: "mute" }]);
    cleanup();

    const held: Binding = { component: MIX, control: "mute" };
    const again = await open({ kind: "boolean", writable: true, value: held });
    fireEvent.click(again.getByRole("button", { name: /^Clear/ }));
    assert.deepEqual(again.changes, [null]);
  });

  test("with no Core connected it says so and offers no controls", async () => {
    server.catalog = () => reply(503, { error: "the Q-SYS Core is not connected" }) as never;
    const r = await open({ kind: "boolean", writable: false });
    assert.match(r.container.textContent ?? "", /No Q-SYS Core is connected/);
    assert.deepEqual(components(r.container), [], "no component is invented");
    assert.deepEqual(controls(r.container), []);
    assert.equal(r.container.querySelector("input"), null, "nothing to search");
  });

  test("a bound object with no Core still shows its binding and can be cleared", async () => {
    server.catalog = () => reply(503, { error: "the Q-SYS Core is not connected" }) as never;
    const r = mountBrowser({ kind: "boolean", writable: true, value: { component: MIX, control: "mute" }, onChange: () => {} });
    assert.match(r.container.textContent ?? "", /Lobby_Mixer/);
    assert.match(r.container.textContent ?? "", /mute/);
    assert.ok(r.getByRole("button", { name: /^Clear/ }), "clear is there before any read");
  });

  test("a read that failed for another reason says so, logs it and offers nothing", async () => {
    server.catalog = () => reply(500, { error: "boom" }) as never;
    const r = await open({ kind: "boolean", writable: false });
    assert.match(r.container.textContent ?? "", /could not be read/i);
    assert.doesNotMatch(r.container.textContent ?? "", /No Q-SYS Core is connected/, "a failed read is not 'no Core'");
    assert.deepEqual(components(r.container), []);
    assert.ok(f.logs.some((l) => l.tag === "qsys" && /catalog/.test(l.message)), `no [qsys] line: ${JSON.stringify(f.logs)}`);
  });

  test("a writable browser whose allowlist could not be read offers nothing", async () => {
    server.allowlist = () => reply(500, { error: "disk" }) as never;
    const w = await open({ kind: "boolean", writable: true });
    assert.deepEqual(components(w.container), [], "no allowlist means nothing is known to be writable");
    assert.match(w.container.textContent ?? "", /allowlist could not be read/i);
    assert.ok(f.logs.some((l) => l.tag === "qsys" && /allowlist/.test(l.message)));
    cleanup();
    // A read object does not need the allowlist at all.
    const ro = await open({ kind: "boolean", writable: false });
    assert.deepEqual(components(ro.container), [MIX, AMP]);
  });

  test("a selector plugin's buttons are listed in number order, each with the name the Core draws on it", async () => {
    const SRC = "Lobby_Source";
    // As the server's catalog carries them: in the Core's text order, Legend from Component.Get.
    const buttons = [1, 10, 100, 2, 3].map((n) => ({ Name: `Button ${n}`, Type: "Boolean", Legend: n === 1 ? "Stage" : n === 2 ? "Lectern" : "" }));
    server.catalog = () => ok({ ...CATALOG, components: [...CATALOG.components, { name: SRC, type: "%PLUGIN%_selector", controls: buttons }] });
    server.allowlist = () => ok({ entries: [...ALLOW.entries, ...buttons.map((b) => entry(SRC, b.Name, null, null))] });
    const picked: [Binding | null, string | undefined][] = [];
    const r = mountBrowser({ kind: "press", writable: true, value: null, onChange: (b: Binding | null, legend?: string) => picked.push([b, legend]) } as Props);
    fireEvent.click(r.getByRole("button", { name: "Control" }));
    await wait();
    await into(r as never, SRC);
    assert.deepEqual(controls(r.container), ["Button 1", "Button 2", "Button 3", "Button 10", "Button 100"]);
    const legends = [...r.container.querySelectorAll("[data-qsys-control]")].map((n) => n.querySelector("[data-qsys-legend]")?.textContent?.trim() ?? null);
    assert.deepEqual(legends, ["Stage", "Lectern", null, null, null], "an empty Legend shows nothing");
    fireEvent.click(r.getByRole("button", { name: /^Button 2 Lectern/ }));
    await wait();
    assert.deepEqual(picked, [[{ component: SRC, control: "Button 2" }, "Lectern"]], "the pick carries the Core's name for it");
  });

  test("a selector whose buttons' names the Core would not say says so, and still lists them", async () => {
    const SRC = "Lobby_Source";
    const buttons = [1, 2].map((n) => ({ Name: `Button ${n}`, Type: "Boolean" }));
    server.catalog = () => ok({ ...CATALOG, components: [...CATALOG.components, { name: SRC, type: "plugin", controls: buttons, legendError: "Unknown control" }] });
    const r = await open({ kind: "press", writable: false });
    await into(r, SRC);
    assert.deepEqual(controls(r.container), ["Button 1", "Button 2"]);
    assert.match(r.container.textContent ?? "", /did not say these buttons' names/);
  });

  test("a read object never fetches the allowlist", async () => {
    await open({ kind: "boolean", writable: false });
    assert.ok(!server.reads.includes("/api/qsys/allowlist"), `read ${server.reads.join(", ")}`);
  });
});
