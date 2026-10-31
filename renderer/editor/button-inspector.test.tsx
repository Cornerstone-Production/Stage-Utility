// The Button widget's inspector, through the real components: the Presses control,
// the three panes behind it, and the command each of the first two writes.
//
// Rendered with a stateful wrapper, so onConfig feeds a real useState and the panel
// redraws from what it wrote, against an in-memory server that keeps the rules the
// panel POSTs and PATCHes. What is guarded, and why each is a bug rather than a nicety:
//
//  - A COMPANION OR APP ACTION PICK WRITES THE BUTTON'S OWN COMMAND, WITH THE
//    SPECIFIED FIELDS, AND BINDS THE BUTTON. Each field is one the operator would
//    otherwise find out about at a service: a cooldown left on refuses the second tap,
//    a condition left on refuses it mid-service, Home Assistant left on puts a new
//    entity in somebody's house, and no owner leaves the rule an orphan from birth.
//  - A SECOND PICK ON THE SAME BUTTON REWRITES THAT RULE IN PLACE, found by its owner:
//    a second rule would leave a command nothing presses behind every re-pick, and a
//    rename on label change would break the URL somebody else holds.
//  - A FAILED WRITE LEAVES THE BUTTON UNCHANGED and says why. A Button bound to a
//    command that was never made is a button that does nothing, with no error.
//  - AN APP ACTION WITH A BLANK REQUIRED FIELD WRITES NOTHING until it is filled in:
//    the server would refuse the rule, and a Button bound to a refusing command is
//    worse than one bound to nothing.
//  - A COMMAND PICK WRITES NO RULE and shows where it is used.
//  - LIST IT WITH THE OTHER COMMANDS clears the owner and nothing else.
//
// NOT unit-tested here, because jsdom cannot see it: how the page grid looks, that it
// scrolls sideways inside the panel when a page is wider, and where the page dropdown
// opens. All of that was driven in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import type { LayoutObjectConfig } from "@main/types/views.js";
import { eventually, installDom } from "../test-dom.js";
import { OWNER, PRESS_17_2_0, owned, manifest, serve as serveButtons } from "../test-fixtures/button-server.js";

const teardown = installDom();

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ButtonInspector, NEW_MANUAL_COMMAND_HREF } = await import("./button-inspector.js");
const { timing } = await import("./action-pane.js");
type ButtonConfig = import("./button-inspector.js").ButtonConfig;

after(() => {
  cleanup();
  teardown();
});
afterEach(() => cleanup());
beforeEach(() => {
  timing.fieldWriteMs = 0;
});

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
/** serve() from the fixture, put back after the test. */
function serve(opts: Parameters<typeof serveButtons>[0] = {}) {
  const s = serveButtons(opts);
  restores.push(s.restore);
  return s;
}

/** The panel with a real useState behind onConfig; `configs` is every write. */
function mount(initial: ButtonConfig, owner = OWNER, opts: { throwOnce?: boolean } = {}) {
  let threw = !opts.throwOnce;
  const cues = manifest();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const configs: LayoutObjectConfig[] = [];
  function Harness() {
    const [c, setC] = React.useState<ButtonConfig>(initial);
    return React.createElement(ButtonInspector as never, {
      c,
      cues,
      viewId: owner.viewId,
      viewName: "Booth console",
      objectId: owner.objectId,
      onConfig: (next: LayoutObjectConfig) => {
        if (!threw) {
          threw = true;
          throw new Error("boom");
        }
        configs.push(next);
        setC(next as ButtonConfig);
      },
    });
  }
  const utils = render(React.createElement(QueryClientProvider as never, { client: qc }, React.createElement(Harness)));
  return { ...utils, configs };
}

/** A promise and the function that settles it: holds a write in flight until the test lets it land. */
function gate() {
  let release: () => void = () => {};
  const hold = new Promise<void>((r) => (release = r));
  return { hold, release };
}
const option = (root: HTMLElement, name: string) => {
  const o = [...root.querySelectorAll('[role="option"]')].find((x) => x.textContent === name);
  assert.ok(o, `no "${name}" option`);
  return o as HTMLElement;
};

const UNSET: ButtonConfig = { type: "cue-button", cue: "", showDevice: true };

const seg = (root: HTMLElement, name: string) => {
  const b = [...root.querySelectorAll('[aria-label="Presses"] button')].find((x) => x.textContent === name);
  assert.ok(b, `no "${name}" choice`);
  return b as HTMLElement;
};
const keyAt = (root: HTMLElement, row: number, col: number) =>
  root.querySelector<HTMLElement>(`[role="gridcell"][data-row="${row}"][data-col="${col}"]`);
const gridReady = async (root: HTMLElement) => eventually(() => assert.ok(root.querySelector("[data-page-grid]"), "the page grid never drew"));
const settleAct = async () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("the Presses control", () => {
  test("offers Companion, App action and A command, and starts on Companion", async () => {
    serve();
    const { container } = mount(UNSET);
    const labels = [...container.querySelectorAll('[aria-label="Presses"] button')].map((b) => b.textContent);
    assert.deepEqual(labels, ["Companion", "App action", "A command"]);
    assert.equal(seg(container, "Companion").getAttribute("aria-pressed"), "true");
    await gridReady(container);
  });

  test("shows the choice a bound Button already has, from its own rule", async () => {
    serve({ rules: [owned("btn_shutter", PRESS_17_2_0)] });
    const a = mount({ type: "cue-button", cue: "btn_shutter", showDevice: true });
    await eventually(() => assert.equal(seg(a.container, "Companion").getAttribute("aria-pressed"), "true"));
    cleanup();
    serve({ rules: [owned("btn_refresh", { id: "display.refresh", params: {} })] });
    const b = mount({ type: "cue-button", cue: "btn_refresh", showDevice: true });
    await eventually(() => assert.equal(seg(b.container, "App action").getAttribute("aria-pressed"), "true"));
    cleanup();
    serve();
    const c = mount({ type: "cue-button", cue: "stage_reset", showDevice: true });
    await eventually(() => assert.equal(seg(c.container, "A command").getAttribute("aria-pressed"), "true"));
  });

  test("switching the choice writes nothing", async () => {
    const s = serve();
    const { container, configs } = mount(UNSET);
    fireEvent.click(seg(container, "App action"));
    fireEvent.click(seg(container, "A command"));
    await settleAct();
    assert.deepEqual(configs, []);
    assert.deepEqual(s.posts, []);
  });
});

describe("Companion", () => {
  test("picking a key writes the Button's own command and binds the Button to it", async () => {
    const s = serve();
    const { container, configs } = mount({ type: "cue-button", cue: "", label: "Shutter", showDevice: true });
    await gridReady(container);
    fireEvent.click(keyAt(container, 2, 0)!);
    await eventually(() => assert.equal(configs.length, 1));

    assert.equal(s.posts.length, 1);
    const rule = s.posts[0]!;
    assert.deepEqual(
      { ...rule, action: undefined },
      {
        name: "Shutter",
        enabled: true,
        trigger: { id: "call.by-name", params: { name: "btn_shutter", says: "Shutter", homeAssistant: "hidden" } },
        conditions: [],
        action: undefined,
        cooldownSec: 0,
        oncePerService: false,
        ownedBy: OWNER,
      },
      "the command's shape: called by name, hidden from Home Assistant, no conditions, no cooldown, owned",
    );
    const action = rule.action as { id: string; params: Record<string, unknown> };
    assert.equal(action.id, "companion.press");
    assert.deepEqual(
      [action.params.page, action.params.row, action.params.col, action.params.pageId, action.params.label, action.params.actionIds, action.params.status],
      [17, 2, 0, "id17", "Proj Shutter", "act.17.2.0", "in-place"],
      "the press carries the fingerprint the reconcile compares",
    );
    assert.deepEqual(configs[0], { type: "cue-button", cue: "btn_shutter", label: "Shutter", showDevice: true });
  });

  test("with no label the command is named from the picked button", async () => {
    const s = serve();
    const { container, configs } = mount(UNSET);
    await gridReady(container);
    fireEvent.click(keyAt(container, 0, 0)!);
    await eventually(() => assert.equal(configs.length, 1));
    // An _on ending would read as half of an ON/OFF pair, and a half with no partner never appears.
    assert.equal((s.posts[0]!.trigger as { params: { name: string } }).params.name, "btn_projectors_on_cue");
    assert.equal(s.posts[0]!.name, "Projectors ON");
    // What a Button with no label draws: the manifest names a command by `says`, and without
    // it that is the cue name humanised ("Btn Projectors On Cue").
    assert.equal((s.posts[0]!.trigger as { params: { says: string } }).params.says, "Projectors ON");
  });

  test("picking again on the same Button rewrites its rule in place: one rule, the same name", async () => {
    const s = serve();
    const { container, configs } = mount({ type: "cue-button", cue: "", showDevice: true });
    await gridReady(container);
    fireEvent.click(keyAt(container, 2, 0)!);
    await eventually(() => assert.equal(configs.length, 1));
    const cue = (configs[0] as { cue: string }).cue;

    // The label changes, then another key is picked.
    fireEvent.change(container.querySelector('input[aria-label="Label"]')!, { target: { value: "Totally different" } });
    fireEvent.click(keyAt(container, 0, 0)!);
    await eventually(() => assert.equal(s.patches.length, 1, "a second pick must rewrite the rule, not make another"));

    assert.equal(s.posts.length, 1, "no second rule");
    assert.equal(s.rules.length, 1);
    assert.equal(s.patches[0]!.id, "rule-1");
    const patch = s.patches[0]!.patch as {
      action: { params: { row: number; col: number } };
      enabled: boolean;
      trigger: { params: { name: string; says: string } };
    };
    assert.deepEqual([patch.action.params.row, patch.action.params.col], [0, 0]);
    assert.equal(patch.enabled, true, "a rewrite switches the command back on");
    assert.equal(patch.trigger.params.name, cue, "the command's own name is never rewritten");
    assert.equal(patch.trigger.params.says, "Totally different", "what a Button with no label draws follows the pick");
    assert.equal(configs.some((c) => (c as { cue?: string }).cue !== undefined && (c as { cue: string }).cue !== cue), false, "the Button keeps the same command name");
  });

  test("a reference key is picked as the button it points at, and a page control cannot be picked", async () => {
    const s = serve();
    const { container, configs } = mount(UNSET);
    await gridReady(container);
    assert.equal(keyAt(container, 0, 7), null, "a page control is blank, not a button");
    const ref = keyAt(container, 1, 3)!;
    assert.equal(ref.getAttribute("data-kind"), "reference");
    assert.ok(ref.textContent?.includes("ref"), "a reference is marked as one");
    fireEvent.click(ref);
    await eventually(() => assert.equal(configs.length, 1));
    const p = (s.posts[0]!.action as { params: Record<string, unknown> }).params;
    assert.deepEqual([p.page, p.row, p.col], [17, 2, 0], "a press goes to the reference's own target");
  });

  test("the picked button's page, row and column are shown, and there are no typed coordinates", async () => {
    serve({ rules: [owned("btn_shutter", PRESS_17_2_0)] });
    const { container } = mount({ type: "cue-button", cue: "btn_shutter", showDevice: true });
    await eventually(() => assert.ok(container.textContent?.includes("page 17 · row 2 · column 0")));
    assert.equal(container.querySelectorAll('input[type="number"], [aria-label="Row"], [aria-label="Column"]').length, 0);
    await gridReady(container);
    assert.equal(keyAt(container, 2, 0)!.getAttribute("aria-pressed"), "true");
  });

  test("the page dropdown leaves empty pages out, filters by number or name, and the arrows step through the listed pages", async () => {
    serve();
    const { container } = mount(UNSET);
    await gridReady(container);
    fireEvent.click(container.querySelector('[aria-label="Companion page"]')!);
    const listed = () => [...container.querySelectorAll('[role="listbox"][aria-label="Pages"] [role="option"]')].map((o) => o.textContent);
    assert.deepEqual(listed(), ["17Projectors2", "20Lighting1", "61Foyer TVs1"], "page 50 is empty and left out");
    const filter = container.querySelector<HTMLInputElement>('[aria-label="Filter pages"]')!;
    fireEvent.change(filter, { target: { value: "6" } });
    assert.deepEqual(listed(), ["61Foyer TVs1"], "by number");
    fireEvent.change(filter, { target: { value: "light" } });
    assert.deepEqual(listed(), ["20Lighting1"], "by name");
    fireEvent.keyDown(filter, { key: "Enter" });
    await eventually(() => assert.ok(container.querySelector('[data-page-grid="20"]')));

    fireEvent.click(container.querySelector('[aria-label="Next page"]')!);
    await eventually(() => assert.ok(container.querySelector('[data-page-grid="61"]'), "Next skips the empty page"));
    assert.equal((container.querySelector('[aria-label="Next page"]') as HTMLButtonElement).disabled, true);
    fireEvent.click(container.querySelector('[aria-label="Previous page"]')!);
    await eventually(() => assert.ok(container.querySelector('[data-page-grid="20"]')));
  });

  test("a label search reaches every page, and picking a result picks that button", async () => {
    const s = serve();
    const { container, configs } = mount(UNSET);
    await gridReady(container);
    fireEvent.change(container.querySelector('[aria-label="Find a Companion button"]')!, { target: { value: "foyer" } });
    const hit = [...container.querySelectorAll('[aria-label="Matching buttons"] button')];
    assert.equal(hit.length, 1);
    fireEvent.click(hit[0]!);
    await eventually(() => assert.equal(configs.length, 1));
    const p = (s.posts[0]!.action as { params: Record<string, unknown> }).params;
    assert.deepEqual([p.page, p.row, p.col], [61, 0, 0]);
  });

  test("Companion unreachable says so, and draws no empty page", async () => {
    serve({ companionDown: true });
    const { container } = mount(UNSET);
    await eventually(() => assert.ok(container.textContent?.includes("Companion refused the connection")));
    assert.equal(container.querySelector("[data-page-grid]"), null);
  });

  test("a refused write leaves the Button as it was and says why", async () => {
    const s = serve({ refuse: true });
    const { container, configs } = mount(UNSET);
    await gridReady(container);
    fireEvent.click(keyAt(container, 2, 0)!);
    await eventually(() => assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes("already used")));
    assert.equal(s.posts.length, 1);
    assert.deepEqual(configs, [], "the Button must not be bound to a command that was never made");
  });
});

describe("App action", () => {
  test("lists the actions under the rule editor's headings, without Press a Companion button", async () => {
    serve();
    const { container } = mount(UNSET);
    fireEvent.click(seg(container, "App action"));
    await eventually(() => assert.ok(container.querySelector('[aria-label="App actions"] [role="option"]')));
    const options = [...container.querySelectorAll('[aria-label="App actions"] [role="option"]')].map((o) => o.textContent);
    assert.deepEqual(options, ["Refresh displays", "Blank displays", "Write a log message"]);
    assert.ok(container.querySelector('[aria-label="App actions"] [role="group"]'), "grouped under headings");
  });

  test("picking an action with nothing to fill in writes the command at once", async () => {
    const s = serve();
    const { container, configs } = mount({ type: "cue-button", cue: "", label: "Refresh", showDevice: true });
    fireEvent.click(seg(container, "App action"));
    await eventually(() => assert.ok(container.querySelector('[role="option"]')));
    fireEvent.click([...container.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Refresh displays")!);
    await eventually(() => assert.equal(configs.length, 1));
    assert.deepEqual(s.posts[0]!.action, { id: "display.refresh", params: {} });
    assert.equal((s.posts[0]!.ownedBy as { objectId: string }).objectId, "o1");
    assert.equal((configs[0] as { cue: string }).cue, "btn_refresh");
  });

  test("a blank required field is marked and writes nothing until it is filled in", async () => {
    const s = serve();
    const { container, configs } = mount(UNSET);
    fireEvent.click(seg(container, "App action"));
    await eventually(() => assert.ok(container.querySelector('[role="option"]')));
    fireEvent.click([...container.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Write a log message")!);
    await eventually(() => assert.ok(container.querySelector('[aria-label="Message"]')));
    await settleAct();
    assert.equal(s.posts.length, 0, "the server would refuse a rule with a blank required field");
    assert.deepEqual(configs, []);
    assert.ok(container.textContent?.includes("Required"), "the blank field is marked, as the rule editor marks it");

    fireEvent.change(container.querySelector('[aria-label="Message"]')!, { target: { value: "Hello" } });
    await eventually(() => assert.equal(s.posts.length, 1));
    assert.deepEqual(s.posts[0]!.action, { id: "log.message", params: { message: "Hello" } });
    await eventually(() => assert.equal(configs.length, 1));
  });
});

describe("A command", () => {
  test("lists Your commands then Built in, without another Button's own command", async () => {
    serve({ rules: [owned("btn_other", { id: "display.refresh", params: {} }, { id: "other-1", ownedBy: { viewId: "booth", objectId: "someone-else" } })] });
    const { container } = mount({ type: "cue-button", cue: "stage_reset", showDevice: true });
    await eventually(() => assert.ok(container.querySelectorAll("optgroup").length > 0));
    const groups = () => [...container.querySelectorAll("optgroup")];
    assert.deepEqual(groups().map((g) => g.label), ["Your commands", "Built in"]);
    // Once the rules have been read: until then nothing says which commands are owned.
    await eventually(() =>
      assert.deepEqual(
        groups().map((g) => [...g.querySelectorAll("option")].map((o) => o.value)),
        [["projectors", "stage_reset"], ["obs_record"]],
        "btn_other belongs to another Button and is not offered",
      ),
    );
  });

  test("picking a command binds it, writes no rule, and keeps the label", async () => {
    const s = serve();
    const { container, configs } = mount({ type: "cue-button", cue: "", label: "Lights", showDevice: true });
    fireEvent.click(seg(container, "A command"));
    fireEvent.change(container.querySelector("select")!, { target: { value: "stage_reset" } });
    assert.deepEqual(configs.at(-1), { type: "cue-button", cue: "stage_reset", label: "Lights", showDevice: true });
    await settleAct();
    assert.deepEqual([s.posts, s.patches], [[], []]);
  });

  test("shows Used on from the usage read, and adds this screen when the Button is not saved yet", async () => {
    serve({
      usage: {
        stage_reset: [
          { viewId: "home", viewName: "Home", objectId: "h1", label: "", home: true },
          { viewId: "foh", viewName: "FOH iPad", objectId: "f1", label: "", home: false },
          { viewId: "foh", viewName: "FOH iPad", objectId: "f2", label: "", home: false },
        ],
      },
    });
    const { container } = mount({ type: "cue-button", cue: "stage_reset", showDevice: true });
    await eventually(() => assert.ok(container.textContent?.includes("Used on")));
    const chips = [...container.querySelectorAll("p span.rounded")].map((c) => c.textContent);
    assert.deepEqual(chips, ["Home", "FOH iPad", "Booth console"], "one chip per screen, this one included");
  });

  test("offers + New manual command… as a link to /automation?new=manual, in a new tab", async () => {
    serve();
    const { container } = mount(UNSET);
    fireEvent.click(seg(container, "A command"));
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent === "+ New manual command…");
    assert.ok(link, "no + New manual command… link");
    assert.equal(link.getAttribute("href"), "/automation?new=manual");
    assert.equal(NEW_MANUAL_COMMAND_HREF, "/automation?new=manual");
    assert.equal(link.getAttribute("target"), "_blank");
  });
});

describe("what it saved as", () => {
  test("a Button with nothing chosen says so", async () => {
    serve();
    const { container } = mount(UNSET);
    assert.ok(container.textContent?.includes("Nothing chosen yet"));
  });

  test("an owned command names itself, and List it with the other commands clears only the owner", async () => {
    const s = serve({ rules: [owned("btn_shutter", PRESS_17_2_0)] });
    const { container, configs } = mount({ type: "cue-button", cue: "btn_shutter", showDevice: true });
    await eventually(() => assert.ok(container.textContent?.includes("Saved as this button’s own command")));
    assert.ok(container.textContent?.includes("btn_shutter"));
    assert.ok(container.textContent?.includes("Simulate, Disarm and the activity log apply."));

    fireEvent.click(container.querySelector('[role="switch"][aria-label="List it with the other commands"]')!);
    await eventually(() => assert.equal(s.patches.length, 1));
    assert.deepEqual(s.patches[0], { id: "own-1", patch: { ownedBy: null } }, "nothing but the owner changes");
    assert.deepEqual(configs, [], "the Button keeps pressing the same command");
    // And the panel now reads as a plain command.
    await eventually(() => assert.equal(seg(container, "A command").getAttribute("aria-pressed"), "true"));
    assert.equal(container.textContent?.includes("Saved as this button"), false);
  });

  test("a refused List it says why and leaves the switch where it was", async () => {
    serve({ rules: [owned("btn_shutter", PRESS_17_2_0)], refuse: true });
    const { container } = mount({ type: "cue-button", cue: "btn_shutter", showDevice: true });
    await eventually(() => assert.ok(container.querySelector('[aria-label="List it with the other commands"]')));
    fireEvent.click(container.querySelector('[aria-label="List it with the other commands"]')!);
    await eventually(() => assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes("refused")));
    assert.equal(container.querySelector('[aria-label="List it with the other commands"]')!.getAttribute("aria-checked"), "false");
  });
});

describe("Label and Show device", () => {
  test("Label writes to the Button, and its placeholder is the name of what it presses", async () => {
    serve();
    const { container, configs } = mount({ type: "cue-button", cue: "stage_reset", showDevice: true });
    const label = container.querySelector<HTMLInputElement>('input[aria-label="Label"]')!;
    assert.equal(label.placeholder, "Stage reset");
    fireEvent.change(label, { target: { value: "Reset" } });
    assert.equal((configs.at(-1) as { label?: string }).label, "Reset");
  });

  test("Show device is there for a pair, and not for a command with no room to show", async () => {
    serve();
    const pair = mount({ type: "cue-button", cue: "projectors", showDevice: true });
    assert.ok(pair.container.querySelector('[role="switch"][aria-label="Show device"]'), "a pair has a reading to show");
    fireEvent.click(pair.container.querySelector('[aria-label="Show device"]')!);
    assert.equal((pair.configs.at(-1) as { showDevice?: boolean }).showDevice, false);
    cleanup();
    const lone = mount({ type: "cue-button", cue: "stage_reset", showDevice: true });
    assert.equal(lone.container.querySelector('[aria-label="Show device"]'), null, "stage_reset has no room: the switch would change nothing");
  });
});

describe("writes that overlap", () => {
  test("two picks in a row are written one after the other: one command, rewritten", async () => {
    const { hold, release } = gate();
    const s = serve({ hold });
    const { container } = mount(UNSET);
    fireEvent.click(seg(container, "App action"));
    await eventually(() => option(container, "Refresh displays"));
    fireEvent.click(option(container, "Refresh displays"));
    fireEvent.click(option(container, "Blank displays"));
    await settleAct();
    release();
    await eventually(() => assert.equal(s.patches.length, 1, "the second pick rewrites the command the first made"));
    assert.equal(s.posts.length, 1, "one command, not one per pick");
  });

  test("the page grid is locked while a pick is being written", async () => {
    const { hold, release } = gate();
    const s = serve({ hold });
    const { container } = mount(UNSET);
    await gridReady(container);
    fireEvent.click(keyAt(container, 2, 0)!);
    await settleAct();
    assert.equal(keyAt(container, 0, 0)!.hasAttribute("disabled"), true, "a second pick must not race the first");
    fireEvent.click(keyAt(container, 0, 0)!);
    release();
    await eventually(() => assert.equal(s.posts.length, 1));
    await settleAct();
    assert.deepEqual([s.posts.length, s.patches.length], [1, 0], "the click on the locked key did nothing");
  });

  test("a typed field still waiting out its delay is written when the panel goes", async () => {
    timing.fieldWriteMs = 60_000;
    const s = serve();
    const { container, unmount } = mount(UNSET);
    fireEvent.click(seg(container, "App action"));
    await eventually(() => option(container, "Write a log message"));
    fireEvent.click(option(container, "Write a log message"));
    await eventually(() => assert.ok(container.querySelector('[aria-label="Message"]')));
    fireEvent.change(container.querySelector('[aria-label="Message"]')!, { target: { value: "Hello" } });
    await settleAct();
    assert.equal(s.posts.length, 0, "still waiting");
    unmount();
    await eventually(() => assert.equal(s.posts.length, 1, "a typed value must not be lost to a click elsewhere"));
    assert.deepEqual(s.posts[0]!.action, { id: "log.message", params: { message: "Hello" } });
  });

  test("List it with the other commands writes a field that is still waiting first, and mints nothing", async () => {
    timing.fieldWriteMs = 60_000;
    const s = serve({ rules: [owned("btn_log", { id: "log.message", params: { message: "a" } })] });
    const { container } = mount({ type: "cue-button", cue: "btn_log", showDevice: true });
    await eventually(() => assert.ok(container.querySelector('[aria-label="Message"]')));
    fireEvent.change(container.querySelector('[aria-label="Message"]')!, { target: { value: "ab" } });
    await settleAct();
    fireEvent.click(container.querySelector('[aria-label="List it with the other commands"]')!);
    await eventually(() => assert.equal(s.patches.length, 2));
    const [first, second] = s.patches;
    assert.deepEqual((first!.patch.action as { params: unknown }).params, { message: "ab" }, "the typed field lands first");
    assert.deepEqual(second!.patch, { ownedBy: null });
    assert.equal(s.posts.length, 0, "no second command is made for the late write");
  });

  test("a command picked after switching away during a typed field's delay is not overwritten when that write lands", async () => {
    timing.fieldWriteMs = 60_000;
    const { hold, release } = gate();
    const s = serve({ rules: [owned("btn_log", { id: "log.message", params: { message: "a" } })], hold });
    const { container, configs } = mount({ type: "cue-button", cue: "btn_log", showDevice: true });
    await eventually(() => assert.ok(container.querySelector('[aria-label="Message"]')));
    fireEvent.change(container.querySelector('[aria-label="Message"]')!, { target: { value: "ab" } });
    await settleAct();
    fireEvent.click(seg(container, "A command"));
    await eventually(() => assert.ok(container.querySelector("select")));
    fireEvent.change(container.querySelector("select")!, { target: { value: "stage_reset" } });
    release();
    await eventually(() => assert.equal(s.patches.length, 1));
    await settleAct();
    await settleAct();
    assert.equal((configs.at(-1) as { cue: string }).cue, "stage_reset", "the later pick wins");
  });

  test("a write that throws is shown, and the next one still runs", async () => {
    const s = serve();
    const { container } = mount(UNSET, OWNER, { throwOnce: true });
    fireEvent.click(seg(container, "App action"));
    await eventually(() => option(container, "Refresh displays"));
    fireEvent.click(option(container, "Refresh displays"));
    await eventually(() => assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes("boom")));
    fireEvent.click(option(container, "Blank displays"));
    await eventually(() => assert.equal(s.patches.length, 1, "the chain survived the throw"));
  });
});

describe("a Button that copies of it also press", () => {
  test("a re-pick leaves the shared command to the copy and gives this Button a new one", async () => {
    const shared = owned("btn_shutter", PRESS_17_2_0);
    const s = serve({
      rules: [shared],
      usage: {
        btn_shutter: [
          { viewId: "booth", viewName: "Booth console", objectId: "o1", label: "", home: false },
          { viewId: "foh", viewName: "FOH iPad", objectId: "copy", label: "", home: false },
        ],
      },
    });
    const { container, configs } = mount({ type: "cue-button", cue: "btn_shutter", showDevice: true });
    await gridReady(container);
    await eventually(() => assert.equal(keyAt(container, 2, 0)!.getAttribute("aria-pressed"), "true"));
    fireEvent.click(keyAt(container, 0, 0)!);
    await eventually(() => assert.equal(configs.length, 1));
    const sharedNow = s.rules.find((r) => r.id === "own-1")!;
    assert.deepEqual(sharedNow.action, PRESS_17_2_0, "what the copy presses is not rewritten under it");
    assert.deepEqual(sharedNow.ownedBy, { viewId: "foh", objectId: "copy" }, "it now belongs to the copy");
    assert.equal(s.posts.length, 1);
    assert.deepEqual(s.posts[0]!.ownedBy, OWNER);
    const made = (s.posts[0]!.trigger as { params: { name: string } }).params.name;
    assert.notEqual(made, "btn_shutter");
    assert.equal((configs[0] as { cue: string }).cue, made);
  });
});

describe("the page list", () => {
  test("with no page that has anything on it, the pane says so instead of reading for ever", async () => {
    serve({ noPages: true });
    const { container } = mount(UNSET);
    await eventually(() => assert.ok(container.textContent?.includes("Companion has no page with buttons on it")));
    assert.equal(container.textContent?.includes("Reading Companion"), false);
  });

  test("a pick on a page that is no longer listed still steps to the nearest listed page either way", async () => {
    const onEmpty = { id: "page-50", params: { page: 50, row: 0, col: 0, pageId: "id50", label: "Foyer ON", actionIds: "x", status: "in-place", lastSeenAt: "x", movedFrom: "" } };
    serve({ rules: [owned("btn_old", { id: "companion.press", params: onEmpty.params })] });
    const { container } = mount({ type: "cue-button", cue: "btn_old", showDevice: true });
    await eventually(() => assert.ok(container.querySelector('[data-page-grid="50"]')));
    const prev = container.querySelector('[aria-label="Previous page"]') as HTMLButtonElement;
    const next = container.querySelector('[aria-label="Next page"]') as HTMLButtonElement;
    assert.deepEqual([prev.disabled, next.disabled], [false, false]);
    fireEvent.click(prev);
    await eventually(() => assert.ok(container.querySelector('[data-page-grid="20"]')));
  });
});
