// The New cue dialog, driven through the REAL Automation page against the REAL
// server routes (automation, cues, views, state) and the real engine and stage
// controller, on a throwaway data directory. Only the integrations a rule could
// reach are absent: the actions here are log messages.
//
// What is guarded, each a failure the operator would not see until it was too late:
//
//  - CANCEL LEAVES A RULE BEHIND. The old Add rule saved "Rule N" before the
//    dialog opened. Nothing is written until Create, from any way out.
//  - A DEFAULT THAT IS WRONG. A manual cue never fires by itself, so it starts ON
//    and with a 2 second cooldown; an automatic rule starts OFF with 30.
//  - A CUE NAME THAT CLASHES, or that the manifest would call half of a pair.
//  - A CUE THAT DOES NOT WORK. Run, a console's cue button, the manifest Home
//    Assistant reads, and POST /api/cues/<name> are each asked of a cue made here.
//  - A CONSOLE THAT SILENTLY GOT NO BUTTON. The cue is created and the failing
//    console is NAMED, on a panel that stays.
//  - THE DEEP LINK, /automation?new=manual, which opens the dialog on a manual cue.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see test-dom.ts).
//
// NOT unit-tested here, and driven in a browser instead: the two-column dialog,
// the sidebar stepper's look, the picker panel scrolling inside the body, and the
// dark and light themes. jsdom loads no stylesheet and reports every offsetHeight
// as 0.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "su-new-cue-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import { eventually, installRenderDom, settle } from "../../test-dom.js";
const teardown = installRenderDom();

const { automationRoutes } = await import("../../../main/services/routes/automation-routes.js");
const { cueRoutes } = await import("../../../main/services/routes/cue-routes.js");
const { viewRoutes } = await import("../../../main/services/routes/view-routes.js");
const { stateRoutes } = await import("../../../main/services/routes/state-routes.js");
const { callRoute } = await import("../../../main/services/routes/route-harness.js");
const { automationEngine } = await import("../../../main/services/automation-engine.js");
const { automationLog } = await import("../../../main/services/automation-log.js");
const { stageController } = await import("../../../main/services/stage-controller.js");

const { installRealRoutesFetch, BROWSER: browser } = await import("../../test-fixtures/real-routes-fetch.js");
const bridge = installRealRoutesFetch(
  [
    { prefix: "/api/automation/", handler: automationRoutes },
    { prefix: "/api/cues", handler: cueRoutes },
    { prefix: "/api/views", handler: viewRoutes },
    { prefix: "/api/state", handler: stateRoutes },
  ],
  callRoute,
);
/** Every write the page sent, so "nothing was saved" is a statement about the wire
 *  as well as the store. */
const writes = (): { method: string; url: string; body: string | null }[] => bridge.writes;

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import(
  "@tanstack/react-router"
);
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { Toaster } = await import("../../components/ui/index.js");
const { AutomationSection } = await import("./automation-section.js");
const { consoleButtonDeps } = await import("../../lib/console-cue-buttons.js");

type Rule = import("../../../main/types/automation.js").Rule;
type View = import("../../../main/types/views.js").View;

const realConsoleDeps = { ...consoleButtonDeps };

const ctl = stageController as unknown as {
  state: { views: View[]; [k: string]: unknown };
  broadcast: () => void;
  recomputeResolved: () => void;
};
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};

const layoutWith = (...objects: unknown[]) => ({
  version: 1 as const,
  canvas: { width: 1920, height: 1080 },
  objects: objects as never,
});
const clockObject = { id: "clock", x: 0.1, y: 0.05, w: 0.5, h: 0.2, z: 1, config: { type: "clock" } };
const bigButton = {
  id: "go",
  x: 0.2,
  y: 0.4,
  w: 0.45,
  h: 0.18,
  z: 2,
  config: { type: "cue-button", cue: "something_else" },
  style: { fontSize: 0.09 },
};

function seedViews() {
  ctl.state = {
    ...ctl.state,
    views: [
      { id: "foh", name: "FOH", kind: "custom", createdAt: "", surface: "console", layout: layoutWith(clockObject, bigButton), layoutRev: 4 },
      { id: "booth", name: "Booth", kind: "custom", createdAt: "", surface: "console", layout: layoutWith(clockObject), layoutRev: 1 },
      { id: "wall", name: "Lobby wall", kind: "custom", createdAt: "", surface: "display", layout: layoutWith(clockObject) },
      { id: "cal", name: "Calendar console", kind: "calendar", createdAt: "", surface: "console" },
      // Home: a seeded console on every install, laid out on a grid and not a canvas.
      { id: "home", name: "Home", kind: "custom", createdAt: "", surface: "console", layout: layoutWith(clockObject), layoutRev: 1 },
    ] as View[],
  };
}

const rules = (): Rule[] => automationEngine.listRules();

let client: InstanceType<typeof QueryClient> | null = null;

function page() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(TooltipProvider, null, React.createElement(AutomationSection, {}), React.createElement(Toaster, {})),
  );
}

async function mount() {
  const view = render(page());
  await settle();
  await settle();
  await settle();
  return view;
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
const dialog = (): Element | null => document.querySelector("[data-new-cue]");
const stepBody = (): string => document.querySelector("[data-step-body]")?.getAttribute("data-step-body") ?? "";
const heading = (): string => dialog()?.querySelector("[data-step-heading]")?.textContent ?? "";
const switchOf = (label: string): HTMLElement | null => document.querySelector(`[role="switch"][aria-label="${label}"]`);
const checked = (label: string): string | null => switchOf(label)?.getAttribute("aria-checked") ?? null;

async function typeInto(el: Element | null, value: string, what: string) {
  assert.ok(el, `no field: ${what}`);
  await act(async () => {
    fireEvent.change(el as HTMLInputElement, { target: { value } });
  });
  await settle();
}

const labelledInput = (label: string): HTMLInputElement | null => {
  const row = [...document.querySelectorAll("label")].find((l) => (l.textContent ?? "").startsWith(label));
  return row?.querySelector("input") ?? (row?.getAttribute("for") ? (document.getElementById(row.getAttribute("for")!) as HTMLInputElement | null) : null);
};

/** Choose `id` in the open step's picker panel: walk the headings to it. */
async function pickOption(id: string) {
  for (const h of [...document.querySelectorAll("[data-picker-group]")]) {
    if (document.querySelector(`[data-picker-option="${id}"]`)) break;
    await press(h, "a picker heading");
  }
  await press(document.querySelector(`[data-picker-option="${id}"]`), id);
}

/** New cue → Manual → Next, then the action: a log message with the given text. */
async function manualToName(message = "hello") {
  await press(button("New cue"), "New cue");
  await press(document.querySelector('[data-kind="manual"]'), "the Manual cue card");
  await press(button("Next"), "Next past Kind");
  await pickOption("log.message");
  await typeInto(labelledInput("Message"), message, "Message");
  await press(button("Next"), "Next past What it does");
}

/** Press Create and wait until it has finished: the dialog closed (every write
 *  landed) or it shows its outcome panel (something failed). Reading the rules or
 *  a console layout before then races the writes, which only shows under load. */
async function create(): Promise<void> {
  await press(button("Create"), "Create");
  await eventually(() =>
    assert.ok(dialog() === null || document.querySelector("[data-outcome]") !== null, "Create did not finish"),
  );
}

before(async () => {
  // The engine, once: the rules file is read from the throwaway data directory.
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
  seedViews();
  bridge.writes.length = 0;
  bridge.holdWritesTo = null;
});
afterEach(async () => {
  Object.assign(consoleButtonDeps, realConsoleDeps);
  cleanup();
  client?.clear();
  await settle();
});

const ruleWrites = () => writes().filter((w) => w.url.startsWith("/api/automation/rules"));

describe("nothing is saved until Create", () => {
  test("Cancel after choosing a kind, an action and a name saves nothing", async () => {
    await mount();
    await manualToName();
    await typeInto(labelledInput("Name"), "Projectors", "Name");
    await press(button("Cancel"), "Cancel");
    assert.equal(dialog() === null, true, "Cancel left the dialog open");
    assert.deepEqual(rules(), [], "Cancel left a rule behind");
    assert.deepEqual(ruleWrites(), [], "Cancel wrote to the rules route");
  });

  test("the close button and Escape discard it the same way", async () => {
    await mount();
    await manualToName();
    await press(document.querySelector('[aria-label="Close"]'), "the close button");
    assert.equal(dialog() === null, true);
    await press(button("New cue"), "New cue again");
    assert.ok(dialog(), "a second New cue did not open");
    assert.equal(stepBody(), "kind", "a second dialog did not start from the first step");
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    await settle();
    assert.deepEqual(rules(), []);
    assert.deepEqual(ruleWrites(), []);
  });

  test("opening it and walking to Review writes nothing either", async () => {
    await mount();
    await manualToName();
    await press(button("Next"), "Next past Name");
    await press(button("Skip"), "Skip On a console");
    assert.equal(heading(), "Review");
    assert.deepEqual(rules(), []);
    assert.deepEqual(ruleWrites(), []);
  });
});

describe("a manual cue", () => {
  test("Create writes exactly one rule, with the manual defaults", async () => {
    await mount();
    await manualToName("projectors are on");
    await typeInto(labelledInput("Name"), "Stage reset", "Name");
    await press(button("Next"), "Next past Name");
    await press(button("Skip"), "Skip On a console");

    assert.equal(heading(), "Review");
    assert.equal(checked("Enabled"), "true", "a manual cue is ON before anything is chosen");
    assert.deepEqual(ruleWrites(), [], "nothing is written before Create");
    await create();

    assert.equal(dialog() === null, true, "the dialog stayed open after a clean Create");
    const [rule, ...rest] = rules();
    assert.equal(rest.length, 0, "Create wrote more than one rule");
    const { id: _id, ...fields } = rule;
    assert.deepEqual(fields, {
      name: "Stage reset",
      enabled: true,
      trigger: { id: "call.by-name", params: { name: "stage_reset", homeAssistant: "hidden" } },
      conditions: [],
      action: { id: "log.message", params: { message: "projectors are on" } },
      cooldownSec: 2,
      oncePerService: false,
    });
    assert.equal(ruleWrites().length, 1, "more than one write reached the rules route");
  });

  test("its defaults are on the Name step: Home Assistant off, allowed during a service on", async () => {
    await mount();
    await manualToName();
    assert.equal(stepBody(), "name");
    assert.equal(checked("Home Assistant"), "false");
    assert.equal(checked("Allowed during a service"), "true");
  });

  test("the switches write what they say", async () => {
    await mount();
    await manualToName();
    await typeInto(labelledInput("Name"), "Lobby lights", "Name");
    await press(switchOf("Home Assistant"), "Home Assistant");
    await press(switchOf("Allowed during a service"), "Allowed during a service");
    await press(button("Next"), "Next past Name");
    await press(button("Skip"), "Skip");
    await press(switchOf("Enabled"), "Enabled");
    await create();
    const [rule] = rules();
    assert.deepEqual(rule.trigger.params, { name: "lobby_lights", homeAssistant: "" }, "Home Assistant ON writes the cue shown");
    assert.deepEqual(rule.conditions, [{ id: "service.is-not-live", params: {} }], "refused during a service writes the guard");
    assert.equal(rule.enabled, false, "the Review switch is what Create writes");
  });

  test("a required field blocks Next, and says which", async () => {
    await mount();
    await press(button("New cue"), "New cue");
    await press(document.querySelector('[data-kind="manual"]'), "Manual");
    await press(button("Next"), "Next");
    await pickOption("log.message");
    assert.equal(button("Next")?.disabled, true, "Next was open with the message empty");
    assert.match(document.querySelector("[data-needs]")?.textContent ?? "", /Message/);
    await typeInto(labelledInput("Message"), "x", "Message");
    assert.equal(button("Next")?.disabled, false);
  });

  test("the Review step shows the cue name, read-only, and each row's Change goes back", async () => {
    await mount();
    await manualToName();
    await typeInto(labelledInput("Name"), "Projectors on", "Name");
    await press(button("Next"), "Next");
    await press(button("Skip"), "Skip");
    const row = document.querySelector('[data-review-row="Cue name"]');
    assert.ok(row, "no Cue name row");
    assert.ok((row.textContent ?? "").includes("projectors_on_cue"), `it read ${JSON.stringify(row.textContent)}`);
    assert.equal(row.querySelector("input") === null, true, "the cue name was editable");
    await press(document.querySelector('[aria-label="Change Does"]'), "Change Does");
    assert.equal(stepBody(), "act");
  });
});

describe("the cue name", () => {
  test("is derived from the display name, and unique against names, former names and built-ins", async () => {
    await automationEngine.addRule({
      name: "Existing",
      enabled: true,
      trigger: { id: "call.by-name", params: { name: "stage_reset", aliases: "old_reset" } },
      conditions: [],
      action: { id: "log.message", params: { message: "x" } },
      cooldownSec: 0,
      oncePerService: false,
    });
    const made: string[] = [];
    for (const typed of ["Stage reset", "Old reset", "Display refresh", "Projectors on"]) {
      cleanup();
      await mount();
      await manualToName();
      await typeInto(labelledInput("Name"), typed, "Name");
      await press(button("Next"), "Next");
      await press(button("Skip"), "Skip");
      await create();
      made.push(String(rules().at(-1)?.trigger.params.name));
    }
    assert.deepEqual(made, ["stage_reset_2", "old_reset_2", "display_refresh_2", "projectors_on_cue"]);
  });

  test("a cue made here is accepted by the server's own name check, every time", async () => {
    // The server refuses a name that is malformed or taken; had the dialog derived
    // one it would refuse, Create would fail and nothing would say why.
    await mount();
    await manualToName();
    await typeInto(labelledInput("Name"), "!!!", "Name");
    await press(button("Next"), "Next");
    await press(button("Skip"), "Skip");
    await create();
    assert.equal(rules().at(-1)?.trigger.params.name, "cue");
  });
});

describe("a cue made here works", () => {
  test("its Run button, the cue route, and the manifest a console and Home Assistant read", async () => {
    await mount();
    await manualToName("ran");
    await typeInto(labelledInput("Name"), "Projectors on", "Name");
    await press(switchOf("Home Assistant"), "Home Assistant");
    await press(button("Next"), "Next");
    await press(button("Skip"), "Skip");
    await create();
    await settle();

    // POST /api/cues/<name>, as a console's cue button sends it: same-origin, no token.
    // First: Run sets the cooldown, and a call inside it is refused.
    const call = await callRoute(cueRoutes, "/api/cues/projectors_on_cue", { method: "POST", headers: browser, body: {} });
    assert.equal(call.status, 200, `the cue route refused a cue made here: ${call.body}`);

    // Run, on the row the list now shows.
    const run = document.querySelector("[data-run-button]");
    assert.ok(run, "the new cue has no Run button in the list");
    await press(run, "Run");
    const ran = document.querySelector("[data-run-result]");
    assert.equal(ran?.getAttribute("data-run-result"), "simulated", "Run did not reach the engine");
    assert.ok((ran?.textContent ?? "").includes("nothing was sent"));

    // The manifest: a button, listed for Home Assistant (it was switched on) and for a
    // console. Named projectors_on_cue and not projectors_on, which is the one name
    // the manifest would have called an orphan half of a pair and left out.
    const manifest = (await callRoute(cueRoutes, "/api/cues/manifest", { headers: browser })).json as {
      buttons: { id: string; name: string; available: boolean }[];
    };
    const button1 = manifest.buttons.find((b) => b.id === "projectors_on_cue");
    assert.ok(button1, `Home Assistant's manifest does not list it: ${JSON.stringify(manifest.buttons.map((b) => b.id))}`);
    assert.equal(button1.available, true);
  });

  test("with Home Assistant off it is left out of Home Assistant's manifest but is on the console's", async () => {
    await mount();
    await manualToName();
    await typeInto(labelledInput("Name"), "Reset the stage", "Name");
    await press(button("Next"), "Next");
    await press(button("Skip"), "Skip");
    await create();
    const ids = (r: unknown) => (r as { buttons: { id: string }[] }).buttons.map((b) => b.id);
    const forHome = (await callRoute(cueRoutes, "/api/cues/manifest", { headers: browser })).json;
    const forConsole = (await callRoute(cueRoutes, "/api/cues/manifest?all=1", { headers: browser })).json;
    assert.equal(ids(forHome).includes("reset_the_stage"), false, "a cue with Home Assistant off was published to it");
    assert.equal(ids(forConsole).includes("reset_the_stage"), true, "a console cannot see it");
    // Still callable, which is all voice needs.
    assert.equal((await callRoute(cueRoutes, "/api/cues/reset_the_stage", { method: "POST", headers: browser, body: {} })).status, 200);
  });
});

describe("On a console", () => {
  /** To the console step of a cue called `name`, with the named consoles ticked. */
  async function toConsoleStep(name: string, ticks: string[], label = "") {
    await mount();
    await manualToName();
    await typeInto(labelledInput("Name"), name, "Name");
    await press(button("Next"), "Next past Name");
    assert.equal(stepBody(), "console");
    for (const t of ticks) await press(document.querySelector(`[data-console="${t}"] [role="checkbox"]`), `tick ${t}`);
    if (label) await typeInto(labelledInput("Button label"), label, "Button label");
  }

  test("lists consoles with a canvas layout, not wall views, calendar consoles or Home", async () => {
    await toConsoleStep("x", []);
    const offered = [...document.querySelectorAll("[data-console]")].map((el) => el.getAttribute("data-console"));
    assert.deepEqual(offered, ["foh", "booth"]);
  });

  test("a console list that could not be read says so, and does not claim there are none", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes("/api/state")) {
        return new Response(JSON.stringify({ error: "the stage is not answering" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await mount();
      await manualToName();
      await typeInto(labelledInput("Name"), "x", "Name");
      await press(button("Next"), "Next past Name");
      const said = await eventually(() => {
        const t = dialog()?.textContent ?? "";
        assert.match(t, /Could not read the consoles/);
        return t;
      });
      assert.equal(said.includes("There are no consoles"), false, "a failed read was reported as no consoles");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a ticked console gets a button bound to the cue, under its content, sized like its other buttons", async () => {
    await toConsoleStep("Stage reset", ["foh"], "Reset");
    await press(button("Next"), "Next to Review");
    await create();

    const foh = ctl.state.views.find((v) => v.id === "foh")!;
    assert.equal(foh.layout!.objects.length, 3, "the button was not added to FOH");
    const added = foh.layout!.objects.at(-1)!;
    assert.deepEqual(added.config, { type: "cue-button", cue: "stage_reset", label: "Reset", showDevice: true });
    assert.equal(added.w, bigButton.w, "not sized like FOH's other button");
    assert.equal(added.h, bigButton.h);
    assert.ok(added.y >= bigButton.y + bigButton.h, `not under the existing content: y=${added.y}`);
    assert.equal(foh.layoutRev, 5, "the layout was not saved through the revision check");

    const booth = ctl.state.views.find((v) => v.id === "booth")!;
    assert.equal(booth.layout!.objects.length, 1, "a console that was not ticked was written");
    assert.equal(ctl.state.views.find((v) => v.id === "wall")!.layout!.objects.length, 1, "a wall view was written");
  });

  test("a button on a console is a cue button the manifest resolves, even with Home Assistant off", async () => {
    await toConsoleStep("Stage reset", ["booth"]);
    await press(button("Next"), "Next to Review");
    await create();
    const added = ctl.state.views.find((v) => v.id === "booth")!.layout!.objects.at(-1)!;
    assert.equal((added.config as { cue: string }).cue, "stage_reset");
    const manifest = (await callRoute(cueRoutes, "/api/cues/manifest?all=1", { headers: browser })).json as {
      buttons: { id: string }[];
    };
    assert.ok(manifest.buttons.some((b) => b.id === (added.config as { cue: string }).cue), "the button's cue is not in the manifest");
  });

  test("a blank label is left blank, so the button uses the cue's name", async () => {
    await toConsoleStep("Stage reset", ["booth"]);
    await press(button("Next"), "Next to Review");
    await create();
    const added = ctl.state.views.find((v) => v.id === "booth")!.layout!.objects.at(-1)!;
    assert.equal((added.config as { label: string }).label, "");
  });

  test("while Create is still writing buttons, the Review does not rename the cue to dodge the one it just made", async () => {
    await toConsoleStep("Stage reset", ["booth"]);
    await press(button("Next"), "Next to Review");
    const cueRow = () => document.querySelector('[data-review-row="Cue name"]')?.textContent ?? "";
    assert.ok(cueRow().includes("stage_reset") && !cueRow().includes("stage_reset_2"));
    let release: () => void = () => {};
    bridge.holdWritesTo = { prefix: "/api/views/", until: new Promise<void>((resolve) => (release = resolve)) };
    await act(async () => {
      fireEvent.click(button("Create")!);
    });
    for (let i = 0; i < 4; i++) await settle();
    assert.equal(rules().length, 1, "the rule should exist while the button write is held");
    assert.ok(button("Creating…"), "Create finished before the held write did");
    assert.ok(cueRow().includes("stage_reset") && !cueRow().includes("stage_reset_2"), `the Review renamed the cue: ${cueRow()}`);
    release();
    await eventually(() => assert.equal(dialog() === null, true));
  });

  test("the dialog cannot be closed while Create is writing, so a refusal is always seen", async () => {
    await toConsoleStep("Stage reset", ["booth"]);
    await press(button("Next"), "Next to Review");
    let release: () => void = () => {};
    bridge.holdWritesTo = { prefix: "/api/views/", until: new Promise<void>((resolve) => (release = resolve)) };
    await act(async () => {
      fireEvent.click(button("Create")!);
    });
    for (let i = 0; i < 4; i++) await settle();
    assert.ok(button("Creating…"), "Create finished before the held write did");
    await press(document.querySelector('[aria-label="Close"]'), "the close button");
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    await settle();
    assert.ok(dialog(), "the dialog closed while its buttons were still being written");
    release();
    await eventually(() => assert.equal(dialog() === null, true));
  });

  test("a button that has no room below its layout's content is said to sit on the edge, not dropped quietly", async () => {
    const booth = ctl.state.views.find((v) => v.id === "booth")!;
    booth.layout!.objects = [{ id: "strip", x: 0, y: 0, w: 0.2, h: 0.97, z: 1, config: { type: "clock" } }] as never;
    await toConsoleStep("Stage reset", ["booth"]);
    await press(button("Next"), "Next to Review");
    await create();
    const said = await eventually(() => {
      const t = document.body.textContent ?? "";
      assert.ok(t.includes("Created Stage reset"), "no success toast");
      return t;
    });
    assert.ok(said.includes("no room below") && said.includes("Booth"), `the overlap was not said: ${said.slice(0, 300)}`);
  });

  test("pressing Create twice at once makes one rule (an automatic rule has no duplicate check to refuse the second)", async () => {
    await mount();
    await press(button("New cue"), "New cue");
    await press(document.querySelector('[data-kind="auto"]'), "Automatic rule");
    await press(button("Next"), "Next");
    await pickOption("pco.service-ended");
    await press(button("Next"), "Next");
    await press(button("Skip"), "Skip");
    await pickOption("log.message");
    await typeInto(labelledInput("Message"), "x", "Message");
    await press(button("Next"), "Next");
    await press(button("Next"), "Next");
    await act(async () => {
      const create = button("Create")!;
      fireEvent.click(create);
      fireEvent.click(create);
    });
    await eventually(() => assert.equal(dialog() === null, true));
    assert.equal(rules().length, 1, "a double press made two rules");
  });

  test("Skip adds nothing", async () => {
    await mount();
    await manualToName();
    await press(button("Next"), "Next past Name");
    await press(button("Skip"), "Skip");
    await create();
    assert.equal(rules().length, 1);
    assert.equal(ctl.state.views.find((v) => v.id === "foh")!.layout!.objects.length, 2);
  });

  test("when one console refuses, the cue is still made and the refusing console is NAMED, on a panel that stays", async () => {
    await toConsoleStep("Stage reset", ["foh", "booth"]);
    await press(button("Next"), "Next to Review");
    // The real route's own 409: every read sees a revision the server has moved on from.
    // Put back by afterEach: the retry reads again, and must see the same.
    const realRead = consoleButtonDeps.readViews;
    consoleButtonDeps.readViews = async () =>
      (await realRead()).map((v) => (v.id === "booth" ? { ...v, layoutRev: 0 } : v));
    await create();

    assert.equal(rules().length, 1, "the cue was rolled back or never made");
    assert.equal(ctl.state.views.find((v) => v.id === "foh")!.layout!.objects.length, 3, "the other console was not written");
    assert.equal(ctl.state.views.find((v) => v.id === "booth")!.layout!.objects.length, 1, "the refusing console was written anyway");
    const panel = await eventually(() => {
      const found = document.querySelector("[data-outcome]");
      assert.ok(found, "the dialog closed, or never said, on a failure");
      return found;
    });
    const said = panel.textContent ?? "";
    assert.ok(said.includes("Booth"), `the refusing console is not named: ${JSON.stringify(said)}`);
    assert.ok(said.includes("changed by someone else"), `the reason is not said: ${JSON.stringify(said)}`);
    assert.ok(said.includes("FOH"), "the console that worked is not mentioned");
    assert.ok(said.includes("stage_reset"), "the cue to bind by hand is not named");
    await press(button("Done"), "Done");
    assert.equal(dialog() === null, true);
  });
});

describe("an automatic rule", () => {
  test("Create writes one rule, OFF, with its cooldown of 30, as the steps chose it", async () => {
    await mount();
    await press(button("New cue"), "New cue");
    await press(document.querySelector('[data-kind="auto"]'), "Automatic rule");
    await press(button("Next"), "Next past Kind");
    assert.equal(stepBody(), "trig");
    await pickOption("pco.service-started");
    await press(button("Next"), "Next past When");
    assert.equal(stepBody(), "if");
    await press(button("Skip"), "Skip If");
    assert.equal(stepBody(), "act");
    await pickOption("log.message");
    await typeInto(labelledInput("Message"), "went live", "Message");
    await press(button("Next"), "Next past Then");
    assert.equal(stepBody(), "name");
    assert.equal(
      (document.getElementById("new-cue-name") as HTMLInputElement | null)?.placeholder,
      "Service goes live → Write a log message",
      "the suggested name is when → then",
    );
    await press(button("Next"), "Next past Name");
    assert.equal(heading(), "Review");
    assert.equal(checked("Enabled"), "false", "an automatic rule starts OFF");
    assert.deepEqual(ruleWrites(), []);
    await create();

    const [rule, ...rest] = rules();
    assert.equal(rest.length, 0);
    const { id: _id, ...fields } = rule;
    assert.deepEqual(fields, {
      name: "Service goes live → Write a log message",
      enabled: false,
      trigger: { id: "pco.service-started", params: {} },
      conditions: [],
      action: { id: "log.message", params: { message: "went live" } },
      cooldownSec: 30,
      oncePerService: false,
    });
  });

  test("a condition added on If is written, and its required field blocks Next", async () => {
    await mount();
    await press(button("New cue"), "New cue");
    await press(document.querySelector('[data-kind="auto"]'), "Automatic rule");
    await press(button("Next"), "Next");
    await pickOption("pco.service-started");
    await press(button("Next"), "Next");
    await press(document.querySelector('[data-picker-field="condition"]'), "Add a condition");
    await pickOption("pvp.layer-is-muted");
    assert.ok(document.querySelector('[data-condition="pvp.layer-is-muted"]'), "the condition was not added");
    assert.equal(button("Next")?.disabled, true, "Next was open with the layer empty");
    await typeInto(labelledInput("Layer"), "Lyrics", "Layer");
    await press(button("Next"), "Next past If");
    await pickOption("log.message");
    await typeInto(labelledInput("Message"), "x", "Message");
    await press(button("Next"), "Next");
    await press(button("Next"), "Next");
    await create();
    assert.deepEqual(rules()[0].conditions, [{ id: "pvp.layer-is-muted", params: { layer: "Lyrics" } }]);
  });

  test("Called by name is not a trigger the When step offers", async () => {
    await mount();
    await press(button("New cue"), "New cue");
    await press(document.querySelector('[data-kind="auto"]'), "Automatic rule");
    await press(button("Next"), "Next");
    assert.equal(document.querySelector('[data-picker-option="call.by-name"]') === null, true);
    for (const h of [...document.querySelectorAll("[data-picker-group]")]) await press(h, "a heading");
    assert.equal(document.querySelector('[data-picker-option="call.by-name"]') === null, true);
  });

  test("turning an automatic rule ON warns that it will fire on its own", async () => {
    await mount();
    await press(button("New cue"), "New cue");
    await press(document.querySelector('[data-kind="auto"]'), "Automatic rule");
    await press(button("Next"), "Next");
    await pickOption("pco.service-ended");
    await press(button("Next"), "Next");
    await press(button("Skip"), "Skip");
    await pickOption("log.message");
    await typeInto(labelledInput("Message"), "x", "Message");
    await press(button("Next"), "Next");
    await press(button("Next"), "Next");
    assert.equal(document.body.textContent?.includes("will fire on its own"), false, "the warning showed with the switch off");
    await press(switchOf("Enabled"), "Enabled");
    assert.ok(document.body.textContent?.includes("will fire on its own"));
  });
});

describe("the stepper", () => {
  test("shows each finished step's choice, and a later step is not reachable until the earlier ones are done", async () => {
    await mount();
    await press(button("New cue"), "New cue");
    const stepButton = (id: string) => document.querySelector(`[data-step="${id}"]`) as HTMLButtonElement | null;
    await press(document.querySelector('[data-kind="manual"]'), "Manual");
    assert.equal(stepButton("name")?.disabled, true, "Name was reachable before an action was chosen");
    await press(button("Next"), "Next");
    await pickOption("log.message");
    await typeInto(labelledInput("Message"), "x", "Message");
    await press(button("Next"), "Next");
    assert.ok((stepButton("kind")?.textContent ?? "").includes("Manual cue"), "Kind's choice is not shown");
    assert.ok((stepButton("act")?.textContent ?? "").includes("Write a log message"), "the action is not shown");
    await press(stepButton("kind"), "back to Kind");
    assert.equal(stepBody(), "kind");
    assert.equal(stepButton("console")?.disabled, false, "a step past finished ones was not reachable");
  });

  test("Back goes one step back and keeps what was chosen", async () => {
    await mount();
    await manualToName("kept");
    await press(button("Back"), "Back");
    assert.equal(stepBody(), "act");
    assert.equal(labelledInput("Message")?.value, "kept");
  });
});

describe("the deep link", () => {
  function pageAt(url: string) {
    const rootRoute = createRootRoute({});
    const automation = createRoute({
      getParentRoute: () => rootRoute,
      path: "/automation",
      component: () => page(),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([automation]),
      history: createMemoryHistory({ initialEntries: [url] }),
    });
    const view = render(React.createElement(RouterProvider, { router } as never));
    return { view, router };
  }

  test("/automation?new=manual opens the dialog already on the manual cue's first step, then drops the parameter", async () => {
    const { router } = pageAt("/automation?new=manual");
    for (let i = 0; i < 6; i++) await settle();
    assert.ok(dialog(), "the link did not open the dialog");
    assert.equal(stepBody(), "act", "the link did not choose Manual and move on");
    assert.equal(heading(), "What does it do?");
    assert.equal(
      (document.querySelector('[data-step="kind"]')?.textContent ?? "").includes("Manual cue"),
      true,
      "the stepper does not show the kind the link chose",
    );
    assert.equal("new" in (router.state.location.search as Record<string, unknown>), false, "the parameter was left in the URL");
  });

  test("with no parameter, the page opens with no dialog", async () => {
    pageAt("/automation");
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(dialog() === null, true);
  });

  test("an unrecognised value opens nothing", async () => {
    pageAt("/automation?new=banana");
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(dialog() === null, true);
  });
});

describe("what was there before still works", () => {
  test("a rule that needs setup is marked, and the New cue button is where Add rule was", async () => {
    await automationEngine.addRule({
      name: "Needs a layer",
      enabled: false,
      trigger: { id: "pvp.layer-hidden", params: {} },
      conditions: [{ id: "pvp.layer-is-muted", params: {} }],
      action: { id: "log.message", params: { message: "x" } },
      cooldownSec: 0,
      oncePerService: false,
    });
    await mount();
    assert.ok(document.querySelector("[data-needs-setup]"), "the needs-setup badge is gone");
    assert.ok(button("New cue"), "no New cue button");
    assert.equal(button("Add rule") === null, true, "Add rule is still on the page");
  });
});
