// The Button widget's inspector, through the real components: the Does control and
// the cue dropdown.
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
//  - THE CUE DROPDOWN IS GROUPED "YOUR CUES" THEN "BUILT IN". The owner approved
//    that order; the operator's own cues are the first thing in the list.
//
// NOT unit-tested here, because jsdom cannot see it: how any of this looks, and
// whether the "+ New manual cue…" link opens the right page in a browser. Both were
// checked by driving the real editor.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import type { LayoutObjectConfig } from "@main/types/views.js";
import type { ParamDef } from "@main/types/automation.js";
import { installDom } from "../test-dom.js";
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

const manifest = (over: Partial<CuesLive["manifest"]> = {}): CuesLive => ({
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
    ...over,
  },
  states: new Map(),
});

interface Server {
  /** Every body POSTed to /api/automation/rules. */
  posted: unknown[];
  restore: () => void;
}

/**
 * The server this panel talks to. `existingRules` is what the rule list answers;
 * `write` decides what the POST answers. Anything unrecognised is an empty 200.
 */
function serve(opts: {
  existingRules?: unknown[];
  cues?: CuesLive["manifest"];
  write?: "ok" | "refuse" | "turned-off";
  readRulesFails?: boolean;
} = {}): Server {
  const posted: unknown[] = [];
  const f = stubFetchWithLog((url, init) => {
    if (url.includes("/api/automation/registry")) {
      return reply(200, { triggers: [], conditions: [], actions: ACTIONS });
    }
    if (url.includes("/api/cues/manifest")) return reply(200, opts.cues ?? manifest().manifest);
    if (url.endsWith("/api/automation/rules")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        if (opts.write === "refuse") return reply(400, { error: 'The cue name "walk_now" is already used by "Walk"' });
        return reply(201, { ...body, id: "rule-1", enabled: opts.write === "turned-off" ? false : body.enabled, issues: [] });
      }
      if (opts.readRulesFails) throw new TypeError("fetch failed");
      return reply(200, { rules: opts.existingRules ?? [], settings: {} });
    }
    return reply(200, {});
  });
  return { posted, restore: f.restore };
}

/** The panel with a real useState behind onConfig; `configs` is every write. */
function mount(initial: ButtonConfig, cues: CuesLive | null = manifest()) {
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
// real fetch. A test that needs different answers calls serve() again; stubs
// restore last-in first-out.
let baseline: Server;
beforeEach(() => {
  baseline = serve();
});
afterEach(() => baseline.restore());

const press = (root: HTMLElement, name: string) => {
  const b = [...root.querySelectorAll("button")].find((x) => x.textContent === name);
  assert.ok(b, `no "${name}" button`);
  return b;
};
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
    assert.ok(container.textContent?.includes("The action lives on this button alone."), "the action half is drawn");

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

  test("offers + New manual cue… as a link to the Automation page's creation flow", () => {
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
