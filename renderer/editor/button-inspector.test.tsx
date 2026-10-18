// The Button widget's inspector, through the real components: the Does control, the
// cue dropdown, and "Make it a cue".
//
// Rendered with a stateful wrapper, so onConfig feeds a real useState and the panel
// redraws from what it wrote — the stored TYPE changing is what flips which half of
// the panel is on screen, and an array of what onConfig received would not see a
// panel that wrote the right config and drew the wrong half.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - DOES FLIPS THE STORED TYPE AND KEEPS THE LABEL. Losing the label on a switch
//    would blank a button an operator had already named; keeping the cue or the
//    action across it would leave a config carrying fields its type does not read.
//  - THE CUE DROPDOWN IS GROUPED "YOUR CUES" THEN "BUILT IN", which puts the cue
//    somebody just made first in the list.
//  - MAKE IT A CUE CREATES EXACTLY ONE RULE, WITH THE SPECIFIED FIELDS,
//    AND REBINDS THE WIDGET. Each field is one the operator would otherwise find
//    out about at a service: a cooldown of 0 lets a double tap run it twice, a
//    condition left on refuses it mid-service, Home Assistant left on puts a new
//    entity in somebody's house.
//  - A FAILED WRITE LEAVES THE WIDGET UNCHANGED and says why. A widget rebound to a
//    cue that was never created is a button that does nothing, with no error.
//
// NOT unit-tested here, because jsdom cannot see it: how any of this looks, and
// whether the "+ New manual cue…" link opens the right page in a browser. Both were
// checked by driving the real editor.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import type { LayoutObjectConfig } from "@main/types/views.js";
import type { ParamDef } from "@main/types/automation.js";
import { eventually, installDom } from "../test-dom.js";
import { reply, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ButtonInspector, NEW_MANUAL_CUE_HREF } = await import("./button-inspector.js");
type ButtonConfig = import("./button-inspector.js").ButtonConfig;
type CuesLive = import("../main/use-cue-live.js").CuesLive;

after(() => {
  cleanup();
  teardown();
});
afterEach(() => cleanup());

const ACTIONS: { id: string; label: string; params: ParamDef[] }[] = [
  { id: "display.refresh", label: "Refresh displays", params: [] },
  {
    id: "osc.send",
    label: "Send an OSC message",
    params: [{ key: "argument", label: "Argument", type: "number", min: 0, max: 7 }],
  },
];

const manifest = (): CuesLive => ({
  manifest: {
    version: 1,
    server: { name: "t", lanUrl: null },
    switches: [
      { id: "obs_record", name: "OBS recording", room: "", on: "obs_record_on", off: "obs_record_off", toggle: false, state: "off", available: true, builtin: true },
    ],
    buttons: [
      { id: "stage_reset", name: "Stage reset", room: "", cue: "stage_reset", available: true },
      { id: "display_refresh", name: "Refresh displays", room: "", cue: "display_refresh", available: true, builtin: true },
    ],
  },
  states: new Map(),
});

/** Every body POSTed to /api/automation/rules. */
interface Server {
  posted: unknown[];
}

// serve() puts the real fetch back after the test, last stub first.
const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

/**
 * The server this panel talks to. `existingRules` is what the rule list answers;
 * `write` decides what the POST answers. Anything unrecognised is an empty 200.
 */
function serve(opts: {
  existingRules?: unknown[];
  /** The rule write is refused with a name clash. */
  refuse?: boolean;
  readRulesFails?: boolean;
  /** Holds the rule write until this settles, so a test can act while it is in flight. */
  gate?: Promise<void>;
} = {}): Server {
  const posted: unknown[] = [];
  const f = stubFetchWithLog((url, init) => {
    if (url.includes("/api/automation/registry")) {
      return reply(200, { triggers: [], conditions: [], actions: ACTIONS });
    }
    if (url.includes("/api/cues/manifest")) return reply(200, manifest().manifest);
    if (url.endsWith("/api/automation/rules")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        const answer = () =>
          opts.refuse
            ? reply(400, { error: 'The cue name "walk_now" is already used by "Walk"' })
            : reply(201, { ...body, id: "rule-1", issues: [] });
        return opts.gate ? opts.gate.then(answer) : answer();
      }
      if (opts.readRulesFails) throw new TypeError("fetch failed");
      return reply(200, { rules: opts.existingRules ?? [], settings: {} });
    }
    return reply(200, {});
  });
  restores.push(f.restore);
  return { posted };
}

/** The panel with a real useState behind onConfig; `configs` is every write. */
function mount(initial: ButtonConfig) {
  const cues = manifest();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const configs: LayoutObjectConfig[] = [];
  function Harness() {
    const [c, setC] = React.useState<ButtonConfig>(initial);
    return React.createElement(ButtonInspector as never, {
      c,
      cues,
      onConfig: (next: LayoutObjectConfig) => {
        configs.push(next);
        setC(next as ButtonConfig);
      },
    });
  }
  const utils = render(React.createElement(QueryClientProvider as never, { client: qc }, React.createElement(Harness)));
  return { ...utils, configs };
}

// Every test gets a server, so the action half's registry read never reaches the
// real fetch. A test that needs different answers calls serve() again.
beforeEach(() => {
  serve();
});

const press = (root: HTMLElement, name: string) => {
  const b = [...root.querySelectorAll("button")].find((x) => x.textContent === name);
  assert.ok(b, `no "${name}" button`);
  return b;
};
/** Waits for the registry to load, then presses Make it a cue. */
async function makeIt(root: HTMLElement) {
  await eventually(() => assert.equal(press(root, "Make it a cue").hasAttribute("disabled"), false));
  fireEvent.click(press(root, "Make it a cue"));
}
const pressed = (root: HTMLElement, name: string) => press(root, name).getAttribute("aria-pressed");

describe("the Does control", () => {
  test("flips the stored type both ways, keeps the label, and drops what does not carry over", () => {
    const { container, configs } = mount({ type: "cue-button", cue: "stage_reset", label: "Lights", showDevice: false });
    assert.equal(pressed(container, "Fire a cue"), "true");
    assert.equal(pressed(container, "Run an action"), "false");

    fireEvent.click(press(container, "Run an action"));
    // Exactly this: the cue and Show device are gone, the label is not.
    assert.deepEqual(configs.at(-1), { type: "action-button", actionId: "", params: {}, label: "Lights" });
    assert.equal(pressed(container, "Run an action"), "true", "the panel must redraw as the action half");
    assert.ok(container.textContent?.includes("Make it a cue"), "the action half has Make it a cue");

    fireEvent.click(press(container, "Fire a cue"));
    assert.deepEqual(configs.at(-1), { type: "cue-button", cue: "", label: "Lights", showDevice: true });
    assert.equal(pressed(container, "Fire a cue"), "true");
    assert.ok(container.textContent?.includes("Show device"), "the cue half has Show device");
  });

  test("choosing the mode already chosen writes nothing", () => {
    const { container, configs } = mount({ type: "cue-button", cue: "stage_reset", label: "Lights" });
    fireEvent.click(press(container, "Fire a cue"));
    assert.equal(configs.length, 0, "re-choosing Fire a cue must not clear the cue it is bound to");
  });

  test("a button with no label stays without one across a switch", () => {
    const { container, configs } = mount({ type: "cue-button", cue: "", showDevice: true });
    fireEvent.click(press(container, "Run an action"));
    assert.equal("label" in (configs.at(-1) as object), false, "an absent label must stay absent, not become undefined");
  });
});

describe("Fire a cue", () => {
  test("the dropdown groups the cues, Your cues then Built in", () => {
    const { container } = mount({ type: "cue-button", cue: "", showDevice: true });
    const groups = [...container.querySelectorAll("optgroup")];
    assert.deepEqual(groups.map((g) => g.label), ["Your cues", "Built in"]);
    assert.deepEqual(
      groups.map((g) => [...g.querySelectorAll("option")].map((o) => o.value)),
      [["stage_reset"], ["obs_record", "display_refresh"]],
    );
  });

  test("picking a cue binds it and keeps the label", () => {
    const { container, configs } = mount({ type: "cue-button", cue: "", label: "Lights", showDevice: true });
    fireEvent.change(container.querySelector("select")!, { target: { value: "stage_reset" } });
    assert.deepEqual(configs.at(-1), { type: "cue-button", cue: "stage_reset", label: "Lights", showDevice: true });
  });

  test("offers + New manual cue… as a link to /automation?new=manual, in a new tab", () => {
    const { container } = mount({ type: "cue-button", cue: "", showDevice: true });
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent === "+ New manual cue…");
    assert.ok(link, "no + New manual cue… link");
    assert.equal(link.getAttribute("href"), "/automation?new=manual");
    assert.equal(NEW_MANUAL_CUE_HREF, "/automation?new=manual");
    // A new tab, so an unsaved layout is not left behind.
    assert.equal(link.getAttribute("target"), "_blank");
  });

  test("Show device and Label write to the cue button", () => {
    const { container, configs } = mount({ type: "cue-button", cue: "stage_reset", showDevice: true });
    fireEvent.click(container.querySelector('[role="switch"]')!);
    assert.equal((configs.at(-1) as { showDevice?: boolean }).showDevice, false);
    fireEvent.change(container.querySelector("input")!, { target: { value: "Reset" } });
    assert.equal((configs.at(-1) as { label?: string }).label, "Reset");
  });
});

describe("Make it a cue", () => {
  const ACTION: ButtonConfig = { type: "action-button", actionId: "osc.send", params: { argument: 3 }, label: "Walk now" };

  test("creates exactly one manual cue with the specified fields, and rebinds the widget", async () => {
    const s = serve();
    const { container, configs } = mount(ACTION);
    await makeIt(container);
    await eventually(() => assert.equal(configs.length, 1, "the widget was never rebound"));

    assert.deepEqual(s.posted, [
      {
        name: "Walk now",
        enabled: true,
        trigger: {
          id: "call.by-name",
          // Home Assistant OFF is the stored word `hidden`; `says` is what the
          // picker shows the cue as.
          params: { name: "walk_now", says: "Walk now", homeAssistant: "hidden" },
        },
        // Allowed during a service ON: no service.is-not-live condition.
        conditions: [],
        action: { id: "osc.send", params: { argument: 3 } },
        cooldownSec: 2,
        oncePerService: false,
      },
    ]);
    assert.deepEqual(configs, [{ type: "cue-button", cue: "walk_now", label: "Walk now", showDevice: true }]);
    assert.equal(pressed(container, "Fire a cue"), "true", "the panel must now show the cue half");
  });

  test("a label typed while the write is in flight is the one the button keeps", async () => {
    let release: () => void = () => {};
    const s = serve({ gate: new Promise<void>((r) => (release = r)) });
    const { container, configs } = mount(ACTION);
    await makeIt(container);
    await eventually(() => assert.equal(s.posted.length, 1, "the write has not started"));
    fireEvent.change(container.querySelector("input[placeholder='Send an OSC message']")!, { target: { value: "Renamed" } });
    release();
    await eventually(() => assert.equal((configs.at(-1) as { type: string }).type, "cue-button"));
    assert.equal((configs.at(-1) as { label?: string }).label, "Renamed", "the rebind used the label from before the click");
  });

  test("Does and Make it a cue are inert while the write is in flight, and free again after it lands", async () => {
    for (const refuse of [false, true]) {
      cleanup();
      let release: () => void = () => {};
      serve({ gate: new Promise<void>((r) => (release = r)), refuse });
      const { container, configs } = mount(ACTION);
      await makeIt(container);
      assert.equal(press(container, "Run an action").hasAttribute("disabled"), true, "Does must be inert mid-write");
      assert.equal(press(container, "Fire a cue").hasAttribute("disabled"), true);
      assert.equal(press(container, "Making…").hasAttribute("disabled"), true, "Make it a cue must not be pressable twice");
      fireEvent.click(press(container, "Fire a cue"));
      assert.equal(configs.length, 0, "a flip mid-write must not be accepted: the rebind would overwrite it");
      release();
      await eventually(() => assert.equal(press(container, "Fire a cue").hasAttribute("disabled"), false, `still inert after the write (refuse=${refuse})`));
      assert.equal(press(container, "Run an action").hasAttribute("disabled"), false);
      assert.equal(configs.length, refuse ? 0 : 1);
    }
  });

  test("the old default label Action names nothing: the rule, the cue and the rebound button use the action's name", async () => {
    const s = serve();
    const { container, configs } = mount({ type: "action-button", actionId: "display.refresh", params: {}, label: "Action" });
    await makeIt(container);
    await eventually(() => assert.equal(configs.length, 1));
    const rule = s.posted[0] as { name: string; trigger: { params: { name: string; says: string } } };
    assert.equal(rule.name, "Refresh displays");
    assert.equal(rule.trigger.params.name, "refresh_displays");
    assert.equal(rule.trigger.params.says, "Refresh displays");
    assert.deepEqual(configs[0], { type: "cue-button", cue: "refresh_displays", showDevice: true });
  });

  test("a blank label names the rule after the action, and the button keeps no label", async () => {
    const s = serve();
    const { container, configs } = mount({ type: "action-button", actionId: "display.refresh", params: {} });
    await makeIt(container);
    await eventually(() => assert.equal(configs.length, 1));
    const rule = s.posted[0] as { name: string; trigger: { params: { name: string } } };
    assert.equal(rule.name, "Refresh displays");
    assert.equal(rule.trigger.params.name, "refresh_displays");
    assert.deepEqual(configs[0], { type: "cue-button", cue: "refresh_displays", showDevice: true });
  });

  test("the cue name is de-duplicated against cue names, former names and the manifest", async () => {
    serve({
      existingRules: [
        { id: "a", name: "Walk", trigger: { id: "call.by-name", params: { name: "walk_now", aliases: "walk_now_2" } } },
        // Not a cue: its params.name must not be read as one.
        { id: "b", name: "Other", trigger: { id: "clock.at", params: { name: "walk_now_3" } } },
      ],
    });
    const { container, configs } = mount(ACTION);
    await makeIt(container);
    await eventually(() => assert.equal(configs.length, 1));
    assert.equal((configs[0] as { cue: string }).cue, "walk_now_3");
  });

  test("a label ending in on or off does not become half of a pair", async () => {
    serve();
    const { container, configs } = mount({ type: "action-button", actionId: "display.refresh", params: {}, label: "Projectors on" });
    await makeIt(container);
    await eventually(() => assert.equal(configs.length, 1));
    // projectors_on alone is an orphan half, which the manifest drops, so a
    // button bound to it would find no cue.
    assert.equal((configs[0] as { cue: string }).cue, "projectors_on_cue");
  });

  test("a refused write leaves the widget unchanged and says why", async () => {
    const s = serve({ refuse: true });
    const { container, configs } = mount(ACTION);
    await makeIt(container);
    await eventually(() =>
      assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /already used by "Walk"/),
    );
    assert.equal(s.posted.length, 1, "exactly one attempt");
    assert.equal(configs.length, 0, "the widget must not be rebound to a cue that was never created");
    assert.equal(pressed(container, "Run an action"), "true", "the panel must still be the action half");
    assert.equal(press(container, "Make it a cue").hasAttribute("disabled"), false, "and may be tried again");
  });

  test("a rule list that cannot be read writes nothing and says so", async () => {
    const s = serve({ readRulesFails: true });
    const { container, configs } = mount(ACTION);
    await makeIt(container);
    await eventually(() => assert.ok(container.querySelector('[role="alert"]'), "the failure was not shown"));
    assert.equal(s.posted.length, 0, "a name that could not be checked must not be written");
    assert.equal(configs.length, 0);
  });

  test("is not offered until an action is chosen and its fields are complete", async () => {
    const s = serve();
    const empty = mount({ type: "action-button", actionId: "", params: {} });
    await eventually(() => assert.ok(empty.container.querySelectorAll("option").length > 1, "the registry has not loaded"));
    assert.equal(press(empty.container, "Make it a cue").hasAttribute("disabled"), true);
    fireEvent.click(press(empty.container, "Make it a cue"));
    assert.equal(s.posted.length, 0);
    assert.match(empty.container.textContent ?? "", /Choose an action and fill in its fields first/);
    cleanup();

    // An action whose number field is unset: the server would save it turned off.
    const incomplete = mount({ type: "action-button", actionId: "osc.send", params: {} });
    await eventually(() => assert.ok(incomplete.container.textContent?.includes("Argument")));
    assert.equal(press(incomplete.container, "Make it a cue").hasAttribute("disabled"), true);
  });
});
