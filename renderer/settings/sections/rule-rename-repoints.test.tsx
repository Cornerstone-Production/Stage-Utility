// Renaming a command repoints its Buttons, driven through the REAL Automation page
// against the real routes, engine, views store and stage controller on a throwaway
// data directory.
//
// What is guarded:
//
//  - A RENAME LISTS THE PLACES BEFORE SAVE and Save points each Button at the new
//    name through the views API: every screen, Home and a Button inside a container
//    included, and not a Button that names another command.
//  - A SCREEN THAT REFUSES IS NAMED IN THE DIALOG WITH THE REASON. The command stays
//    renamed, the other screens still follow, and the dialog stays open over the
//    refusal instead of closing on something half done.
//  - THE RENAME'S REPOINTS ARE ONE `[automation]` LINE ON THE SERVER LOG, listing
//    what was repointed and what was refused.
//  - MAKE IT AUTOMATIC LISTS THE SAME PLACES AS A WARNING and repoints nothing: the
//    command is gone, and the Buttons read Not set.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see test-dom.ts).
//
// NOT unit-tested here, and driven in a browser instead: the notice's look in the
// dialog and where it sits against the scrolling body. jsdom loads no stylesheet.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "su-rename-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import { eventually, installRenderDom, settle } from "../../test-dom.js";
const teardown = installRenderDom();

const { automationRoutes } = await import("../../../main/services/routes/automation-routes.js");
const { cueRoutes } = await import("../../../main/services/routes/cue-routes.js");
const { viewRoutes } = await import("../../../main/services/routes/view-routes.js");
const { stateRoutes } = await import("../../../main/services/routes/state-routes.js");
const { clientLogRoutes } = await import("../../../main/services/routes/client-log-routes.js");
const { callRoute } = await import("../../../main/services/routes/route-harness.js");
const { automationEngine } = await import("../../../main/services/automation-engine.js");
const { automationLog } = await import("../../../main/services/automation-log.js");
const { stageController } = await import("../../../main/services/stage-controller.js");
const { viewsStore } = await import("../../../main/services/views-store.js");

const { installRealRoutesFetch, BROWSER: browser } = await import("../../test-fixtures/real-routes-fetch.js");
const bridge = installRealRoutesFetch(
  [
    { prefix: "/api/automation/", handler: automationRoutes },
    { prefix: "/api/cues", handler: cueRoutes },
    { prefix: "/api/views", handler: viewRoutes },
    { prefix: "/api/state", handler: stateRoutes },
    { prefix: "/api/log/client", handler: clientLogRoutes },
  ],
  callRoute,
);

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { AutomationSection } = await import("./automation-section.js");
const { consoleButtonDeps } = await import("../../lib/console-cue-buttons.js");
const { resetClientLogLimits } = await import("../../../main/services/routes/client-log-routes.js");

type Rule = import("../../../main/types/automation.js").Rule;
type View = import("../../../main/types/views.js").View;
void browser;

const realDeps = { ...consoleButtonDeps };
const ctl = stageController as unknown as {
  state: { views: View[]; [k: string]: unknown };
  broadcast: () => void;
  recomputeResolved: () => void;
};
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};

const layoutWith = (...objects: unknown[]) => ({ version: 1 as const, canvas: { width: 1920, height: 1080 }, objects: objects as never });
const cueButton = (id: string, cue: string, label = "") => ({
  id,
  x: 0.1,
  y: 0.1,
  w: 0.3,
  h: 0.15,
  z: 1,
  config: { type: "cue-button", cue, ...(label ? { label } : {}) },
});

async function seedViews() {
  const views = [
    {
      id: "foh",
      name: "FOH",
      kind: "custom",
      createdAt: "",
      surface: "console",
      layoutRev: 4,
      layout: layoutWith(
        cueButton("f1", "take_screens", "Screens"),
        { id: "box", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "container" }, children: [cueButton("f2", "take_screens")] },
        cueButton("f3", "something_else"),
      ),
    },
    { id: "booth", name: "Booth", kind: "custom", createdAt: "", surface: "console", layoutRev: 1, layout: layoutWith(cueButton("b1", "take_screens")) },
    { id: "home", name: "Home", kind: "custom", createdAt: "", surface: "console", layoutRev: 1, layout: layoutWith(cueButton("h1", "take_screens")) },
  ] as unknown as View[];
  ctl.state = { ...ctl.state, views };
  await viewsStore.save(views);
}

/** Every cue name a view's Buttons hold now, nested ones included, by object id. */
function cuesIn(viewId: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (objects: { id: string; config: { type?: string; cue?: string }; children?: unknown[] }[]) => {
    for (const o of objects) {
      if (o.config.type === "cue-button") out[o.id] = String(o.config.cue);
      if (o.children) walk(o.children as never);
    }
  };
  walk((ctl.state.views.find((v) => v.id === viewId)?.layout?.objects ?? []) as never);
  return out;
}

const rules = (): Rule[] => automationEngine.listRules();
let client: InstanceType<typeof QueryClient> | null = null;

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, { tab: "commands" }), React.createElement(ConfirmHost, {})),
    ),
  );
  for (let i = 0; i < 4; i++) await settle();
}
async function press(el: Element | null | undefined, what: string) {
  assert.ok(el, `nothing to press: ${what}`);
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
  await settle();
}
const button = (text: string): HTMLButtonElement | null =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
const editorOpen = (): boolean => document.querySelector("[data-rule-editor]") !== null;
const labelled = (text: string): HTMLInputElement | null => {
  const row = [...document.querySelectorAll("label")].find((l) => (l.textContent ?? "").startsWith(text));
  return row?.querySelector("input") ?? null;
};
const notice = (kind: string): Element | null => document.querySelector(`[data-cue-notice="${kind}"]`);
const openRow = (name: string) => press(document.querySelector(`[data-rule-name="${name}"]`)?.closest("button"), name);
async function rename(to: string) {
  const field = labelled("Cue name");
  assert.ok(field, "no cue name field");
  await act(async () => {
    fireEvent.change(field!, { target: { value: to } });
  });
  await settle();
}

/**
 * What the page sent /api/log/client about a rename: one POST per save. The route
 * is the real one and writes the line with console.warn, as logToServer also does
 * in the browser, so counting console lines in this one process would count each
 * twice. The wire is the honest place to count.
 */
let warned: string[] = [];
const automationLines = (): string[] =>
  bridge.writes
    .filter((w) => w.url === "/api/log/client")
    .map((w) => JSON.parse(w.body ?? "{}") as { tag: string; message: string })
    .filter((l) => l.tag === "automation")
    .map((l) => `[${l.tag}] ${l.message}`);
/** The same line, as the server's own log received it. */
const serverLogged = (): boolean => warned.some((l) => l.startsWith("[automation] renamed take_screens"));

before(async () => {
  await automationEngine.init();
});
after(async () => {
  cleanup();
  client?.clear();
  await settle();
  teardown();
  await fs.rm(TMP, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const r of rules()) await automationEngine.removeRule(r.id);
  await automationLog.clear();
  await automationEngine.setSettings({ simulate: true, disarmed: false });
  await automationEngine.addRule({
    name: "Take screens",
    enabled: true,
    trigger: { id: "call.by-name", params: { name: "take_screens", homeAssistant: "hidden" } },
    conditions: [],
    action: { id: "log.message", params: { message: "x" } },
    cooldownSec: 0,
    oncePerService: false,
  });
  await seedViews();
  Object.assign(consoleButtonDeps, realDeps);
  resetClientLogLimits();
  bridge.writes.length = 0;
  warned = [];
  mock.method(console, "warn", (...args: unknown[]) => {
    warned.push(args.map(String).join(" "));
  });
});
afterEach(async () => {
  mock.restoreAll();
  Object.assign(consoleButtonDeps, realDeps);
  cleanup();
  client?.clear();
  await settle();
});

describe("renaming a command", () => {
  test("lists the places before Save, and Save points every Button at the new name", async () => {
    await mount();
    await openRow("Take screens");
    await rename("take_the_screens");
    const n = notice("rename");
    assert.ok(n, "no list of places while renaming");
    const text = n!.textContent ?? "";
    assert.match(text, /FOH · Screens follows the new name/);
    assert.match(text, /Booth follows the new name/);
    assert.match(text, /Home follows the new name/);
    assert.equal(bridge.writes.filter((w) => w.url.startsWith("/api/views")).length, 0, "a view was written before Save");

    await press(button("Save"), "Save");
    await eventually(() => assert.equal(editorOpen(), false, "the dialog did not close"));

    assert.equal(rules()[0]!.trigger.params.name, "take_the_screens");
    assert.deepEqual(cuesIn("foh"), { f1: "take_the_screens", f2: "take_the_screens", f3: "something_else" }, "a nested Button was missed, or another command's was taken");
    assert.deepEqual(cuesIn("booth"), { b1: "take_the_screens" });
    assert.deepEqual(cuesIn("home"), { h1: "take_the_screens" });
  });

  test("writes each screen with its own revision, so a screen being edited elsewhere is refused rather than overwritten", async () => {
    await mount();
    await openRow("Take screens");
    await rename("take_the_screens");
    await press(button("Save"), "Save");
    await eventually(() => assert.equal(editorOpen(), false));
    const viewWrites = bridge.writes.filter((w) => w.url.startsWith("/api/views"));
    const byView = new Map(viewWrites.map((w) => [w.url.split("/").pop(), JSON.parse(w.body ?? "{}").layoutRev]));
    assert.deepEqual([...byView].sort(), [["booth", 1], ["foh", 4], ["home", 1]]);
  });

  test("leaves one [automation] line on the log, listing what was repointed", async () => {
    await mount();
    await openRow("Take screens");
    await rename("take_the_screens");
    await press(button("Save"), "Save");
    await eventually(() => assert.equal(editorOpen(), false));
    await eventually(() => assert.equal(automationLines().length, 1, `lines: ${JSON.stringify(warned)}`));
    const line = automationLines()[0]!;
    assert.match(line, /renamed take_screens to take_the_screens; repointed 4 buttons on Booth, FOH, Home/);
    assert.doesNotMatch(line, /refused/);
    assert.ok(serverLogged(), "the line never reached the server's log");
  });

  test("a screen that refuses is named with the reason, the command stays renamed, and the others still follow", async () => {
    consoleButtonDeps.writeLayout = async (id, layout, rev) => {
      if (id === "booth") throw Object.assign(new Error("This view was changed by someone else"), { status: 400 });
      return realDeps.writeLayout(id, layout, rev);
    };
    await mount();
    await openRow("Take screens");
    await rename("take_the_screens");
    await press(button("Save"), "Save");
    await eventually(() => assert.ok(document.querySelector('[data-repoint-refused-view="booth"]'), "the refusal is not named"));

    assert.equal(editorOpen(), true, "the dialog closed over a refusal");
    const refused = document.querySelector("[data-repoint-refused]")!;
    assert.equal(refused.getAttribute("data-repoint-refused"), "1");
    assert.match(refused.textContent ?? "", /Booth: This view was changed by someone else/);
    assert.equal(rules()[0]!.trigger.params.name, "take_the_screens", "the command was not renamed");
    assert.deepEqual(cuesIn("booth"), { b1: "take_screens" }, "the refused screen was written");
    assert.deepEqual(cuesIn("home"), { h1: "take_the_screens" }, "a screen after the refused one was not written");
    assert.equal(cuesIn("foh").f1, "take_the_screens");

    await eventually(() => assert.equal(automationLines().length, 2));
    assert.match(automationLines()[0]!, /repointed 3 buttons on FOH, Home; 1 refused/);
    assert.match(automationLines()[1]!, /could not point the buttons on Booth at take_the_screens: This view was changed by someone else/);
    // And the dialog no longer calls it a rename: the name it now holds is the new one.
    assert.equal(notice("rename"), null, "the dialog still offers to rename what is renamed");
  });

  test("the places are read fresh at Save: a Button added after the page loaded follows too", async () => {
    await mount();
    await openRow("Take screens");
    await rename("take_the_screens");
    // Another client, or the layout editor, puts a Button on Booth after this page read the usage.
    const booth = ctl.state.views.find((v) => v.id === "booth")!;
    booth.layout!.objects.push(cueButton("late", "take_screens", "Late") as never);
    await viewsStore.save(ctl.state.views);
    await press(button("Save"), "Save");
    await eventually(() => assert.equal(editorOpen(), false));
    assert.deepEqual(cuesIn("booth"), { b1: "take_the_screens", late: "take_the_screens" }, "a Button added after the page loaded was left on the old name");
  });

  test("a rename keeps the old name as a former name, and a Button on a former name follows too", async () => {
    await automationEngine.updateRule(rules()[0]!.id, { trigger: { id: "call.by-name", params: { name: "take_screens", homeAssistant: "hidden", aliases: "older_name" } } });
    ctl.state.views.find((v) => v.id === "booth")!.layout!.objects.push(cueButton("former", "older_name", "Former") as never);
    await viewsStore.save(ctl.state.views);
    await mount();
    await openRow("Take screens");
    await rename("take_the_screens");
    const text = notice("rename")?.textContent ?? "";
    assert.match(text, /take_screens stays as a former name/);
    assert.match(text, /Booth · Former follows the new name/, "the dialog does not list a Button on a former name");
    await press(button("Save"), "Save");
    await eventually(() => assert.equal(editorOpen(), false));
    const p = rules()[0]!.trigger.params;
    assert.equal(p.name, "take_the_screens");
    assert.deepEqual(String(p.aliases).split(","), ["older_name", "take_screens"], "the old name was not kept, or the earlier former name was lost");
    assert.equal(cuesIn("booth").former, "take_the_screens", "a Button on a former name was left behind");
  });

  test("where it is used cannot be read: nothing is repointed, the dialog says so, the old name still works, and /log has it", async () => {
    await mount();
    await openRow("Take screens");
    await rename("take_the_screens");
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).startsWith("/api/cues/usage")) return { ok: false, status: 503, statusText: "503", json: async () => ({ error: "views.json could not be read" }), text: async () => "" };
      return real(input as never, init);
    }) as typeof fetch;
    try {
      await press(button("Save"), "Save");
      await eventually(() => assert.ok(document.querySelector("[data-repoint-unread]"), "the unread usage is not said"));
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(editorOpen(), true, "the dialog closed over Buttons that were not repointed");
    assert.match(document.querySelector("[data-repoint-unread]")?.textContent ?? "", /could not be read: views\.json could not be read/);
    assert.equal(rules()[0]!.trigger.params.name, "take_the_screens");
    assert.equal(String(rules()[0]!.trigger.params.aliases), "take_screens");
    assert.equal(bridge.writes.filter((w) => w.url.startsWith("/api/views")).length, 0);
    assert.ok(automationLines().some((l) => /could not read where it is used, so no button was repointed/.test(l)), JSON.stringify(automationLines()));
  });

  test("a command no Button names is renamed with no list, no views write and no line", async () => {
    await seedViewsWithout();
    await mount();
    await openRow("Take screens");
    await rename("take_the_screens");
    assert.equal(notice("rename"), null);
    await press(button("Save"), "Save");
    await eventually(() => assert.equal(editorOpen(), false));
    assert.equal(rules()[0]!.trigger.params.name, "take_the_screens");
    assert.equal(bridge.writes.filter((w) => w.url.startsWith("/api/views")).length, 0);
    assert.deepEqual(automationLines(), []);
  });

  test("a name the server refuses repoints nothing", async () => {
    await automationEngine.addRule({
      name: "Other",
      enabled: true,
      trigger: { id: "call.by-name", params: { name: "taken_name", homeAssistant: "hidden" } },
      conditions: [],
      action: { id: "log.message", params: { message: "x" } },
      cooldownSec: 0,
      oncePerService: false,
    });
    await mount();
    await openRow("Take screens");
    await rename("taken_name");
    await press(button("Save"), "Save");
    assert.equal(editorOpen(), true, "a refused save closed the dialog");
    assert.equal(bridge.writes.filter((w) => w.url.startsWith("/api/views")).length, 0, "Buttons were pointed at a name the server refused");
    assert.deepEqual(cuesIn("booth"), { b1: "take_screens" });
  });
});

describe("a pair's Used on", () => {
  test("the dialog and the row both count a Button on a half's former name", async () => {
    for (const r of rules()) await automationEngine.removeRule(r.id);
    const half = (name: string, aliases?: string) => ({
      name,
      enabled: true,
      trigger: { id: "call.by-name", params: { name, homeAssistant: "hidden", ...(aliases ? { aliases } : {}) } },
      conditions: [],
      action: { id: "log.message", params: { message: "x" } },
      cooldownSec: 0,
      oncePerService: false,
    });
    await automationEngine.addRule(half("beamers_on", "old_on"));
    await automationEngine.addRule(half("beamers_off"));
    const booth = ctl.state.views.find((v) => v.id === "booth")!;
    booth.layout!.objects.push(cueButton("former-half", "old_on", "Old half") as never);
    await viewsStore.save(ctl.state.views);
    await mount();
    const row = document.querySelector('[data-cue-pair-row="beamers"]')!;
    await eventually(() => assert.match(row.querySelector("[data-used-on]")?.textContent ?? "", /Booth/));
    await press(document.querySelector('[aria-label="the beamers pair"], [data-cue-pair-row="beamers"] button'), "the pair");
    await eventually(() => assert.ok(document.querySelector("[data-rule-editor]")));
    const header = document.querySelector("[data-rule-editor] [data-used-on]");
    assert.match(header?.textContent ?? "", /Booth/, "the dialog does not see a Button on a half's former name");
  });
});

describe("Make it automatic", () => {
  test("lists the same places as a warning, and Save repoints nothing", async () => {
    await mount();
    await openRow("Take screens");
    await press(button("Make it automatic"), "Make it automatic");
    const n = notice("automatic");
    assert.ok(n, "no warning for Make it automatic");
    const text = n!.textContent ?? "";
    assert.match(text, /FOH · Screens reads Not set/);
    assert.match(text, /Booth reads Not set/);
    assert.match(text, /Home reads Not set/);
    assert.equal(notice("rename"), null);

    await press(document.querySelector('[data-picker-field][aria-label="Trigger"]'), "Trigger");
    await press(document.querySelector('[data-picker-group]'), "a heading");
    const option = document.querySelector("[data-picker-option]");
    await press(option, "a trigger");
    await press(button("Save"), "Save");
    const ask = await eventually(() => {
      const el = [...document.querySelectorAll("[role=alertdialog], [role=dialog]")].find((d) => !d.hasAttribute("data-rule-editor"));
      assert.ok(el, "Save did not ask");
      return el;
    });
    await press([...ask.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save anyway"), "Save anyway");
    await eventually(() => assert.equal(editorOpen(), false));
    assert.equal(bridge.writes.filter((w) => w.url.startsWith("/api/views")).length, 0, "Make it automatic wrote a view");
    assert.deepEqual(cuesIn("booth"), { b1: "take_screens" }, "a Button was repointed at a command that no longer exists");
    assert.deepEqual(automationLines(), []);
  });
});

async function seedViewsWithout() {
  const views = [{ id: "booth", name: "Booth", kind: "custom", createdAt: "", surface: "console", layoutRev: 1, layout: layoutWith(cueButton("b1", "other")) }] as unknown as View[];
  ctl.state = { ...ctl.state, views };
  await viewsStore.save(views);
}
