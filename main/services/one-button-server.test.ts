// The server half of the one-button model: a rule that belongs to a Button, where a
// cue is used, the migration of Run an action Buttons, and what happens to a rule
// when its Button goes.
//
// Everything runs the real thing: the load pass that migrates (stage-controller's
// applySurfaceMigration, over a real views.json), the real views and rules stores,
// the real rules and cue routes, and the real engine. The only stub is Companion's
// HTTP API: a test that presses a button presses one in a building.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import type { Output, View } from "../types/stage.js";
import type { Rule } from "../types/automation.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "one-button-server-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { viewsStore } = await import("./views-store.js");
const { settingsStore } = await import("./settings-store.js");
const { automationStore } = await import("./automation-store.js");
const { automationEngine } = await import("./automation-engine.js");
const { AUTOMATION_ACTIONS } = await import("./automation-actions.js");
const { cueRoutes } = await import("./routes/cue-routes.js");
const { automationRoutes } = await import("./routes/automation-routes.js");
const { callRoute } = await import("./routes/route-harness.js");
const { companionDeps } = await import("./companion-api.js");
const { buttonCueRule } = await import("./cue-naming.js");
const { planActionButtonMigration } = await import("./action-button-migration.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

type Pass = (views: View[], outputs: Output[]) => Promise<{ views: View[]; outputs: Output[] }>;
const runLoadPass = (stageController as unknown as { applySurfaceMigration: Pass }).applySurfaceMigration.bind(
  stageController,
) as Pass;

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

// ── The fixture ───────────────────────────────────────────────────────────────

const place = { x: 0.1, y: 0.1, w: 0.2, h: 0.1, z: 1 };
const press = (page: number, row: number, col: number, label: string) => ({
  pageId: "page-opaque",
  page,
  row,
  col,
  label,
});

/**
 * Home, a console, and a second console that the first EMBEDS, each holding Run an
 * action Buttons: at the top of a layout, inside a container, and in the embedded
 * view. Two Buttons say "Shutter", one has the legacy label "Action", one names an
 * action the registry does not have, and one is labelled so its cue would end in
 * `_on`. There are also two cue Buttons already, for the usage list.
 */
function fixtureViews(): View[] {
  const layout = (objects: unknown[]) => ({
    version: 1,
    canvas: { width: 1920, height: 1080, background: null, fit: "responsive" },
    objects,
  });
  return [
    {
      id: "home",
      name: "Home",
      kind: "custom",
      createdAt: "",
      surface: "console",
      // Saved by a human at least once: Home is re-seeded while this is unset, and
      // a Button could only have been put there by that save.
      layoutRev: 1,
      layout: layout([
        {
          id: "h-lights",
          ...place,
          config: { type: "action-button", actionId: "gone.action", params: { room: "foyer", level: 3, flag: true }, label: "Lights" },
          style: { background: "#112233" },
        },
        { id: "h-cue", ...place, config: { type: "cue-button", cue: "projectors", label: "Projectors" } },
      ]),
    },
    {
      id: "v-booth",
      name: "Booth console",
      kind: "custom",
      createdAt: "",
      surface: "console",
      layout: layout([
        {
          id: "b-shutter",
          ...place,
          config: { type: "action-button", actionId: "companion.press", params: press(1, 2, 3, "Shutter"), label: "Shutter" },
          style: { background: "#445566", cornerRadius: 7 },
        },
        {
          id: "b-box",
          ...place,
          config: { type: "container" },
          children: [
            {
              id: "b-proj",
              ...place,
              config: { type: "action-button", actionId: "companion.press", params: press(1, 0, 1, "Projectors ON"), label: "Projectors ON" },
            },
            { id: "b-cue", ...place, config: { type: "cue-button", cue: "projectors", label: "Same cue, nested" } },
          ],
        },
        { id: "b-embed", ...place, config: { type: "view-embed", viewId: "v-foh" } },
      ]),
    },
    {
      id: "v-foh",
      name: "FOH iPad",
      kind: "custom",
      createdAt: "",
      surface: "console",
      layout: layout([
        {
          id: "f-shutter",
          ...place,
          config: { type: "action-button", actionId: "companion.press", params: press(2, 0, 0, "Shutter"), label: "Shutter" },
        },
        {
          id: "f-box",
          ...place,
          config: { type: "container" },
          children: [
            // Deeper still, and with the label every action button once started with.
            {
              id: "f-deep",
              ...place,
              config: { type: "container" },
              children: [{ id: "f-rec", ...place, config: { type: "action-button", actionId: "obs.record", params: { mode: "toggle" }, label: "Action" } }],
            },
          ],
        },
      ]),
    },
  ] as unknown as View[];
}

/** Every Button in a view tree as "<view>/<object>:<type>", sorted: one entry per line. */
function buttonsOf(views: readonly View[]): string[] {
  const out: string[] = [];
  const walk = (viewId: string, objects: readonly { id: string; config: { type: string }; children?: unknown[] }[] | undefined) => {
    for (const o of objects ?? []) {
      if (o.config.type === "action-button" || o.config.type === "cue-button") out.push(`${viewId}/${o.id}:${o.config.type}`);
      walk(viewId, o.children as never);
    }
  };
  for (const v of views) walk(v.id, v.layout?.objects as never);
  return out.sort();
}

const cueOf = (views: readonly View[], viewId: string, objectId: string): string => {
  let found = "";
  const walk = (objects: readonly { id: string; config: { type: string; cue?: string }; children?: unknown[] }[] | undefined) => {
    for (const o of objects ?? []) {
      if (o.id === objectId && o.config.type === "cue-button") found = String(o.config.cue);
      walk(o.children as never);
    }
  };
  walk(views.find((v) => v.id === viewId)?.layout?.objects as never);
  return found;
};

const ruleFor = (rules: readonly Rule[], viewId: string, objectId: string): Rule | undefined =>
  rules.find((r) => r.ownedBy?.viewId === viewId && r.ownedBy.objectId === objectId);

// ── Companion, stubbed ────────────────────────────────────────────────────────

let presses: string[] = [];
const browser = { origin: "http://stage.local:8788", host: "stage.local:8788" };

before(() => {
  companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
  companionDeps.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/press")) presses.push(url);
    return new Response("ok", { status: 200 });
  };
});

// ── The migration ─────────────────────────────────────────────────────────────

describe("migrating Run an action Buttons", () => {
  let migrated: View[];
  let rules: Rule[];
  let lines: string[];

  // A test and not a `before`: the console capture needs a test context. The tests
  // below read what this one produced, and run after it, in order.
  test("the load pass runs over the fixture", async (t) => {
    await settingsStore.patch({ outputs: [] });
    await viewsStore.save(fixtureViews());
    lines = captureConsole(t, "log");
    migrated = (await runLoadPass(await viewsStore.load(), [])).views;
    rules = await automationStore.loadRules();
  });

  test("every action-button, on Home, in a console, in a container and in an embedded view, is now a cue-button", () => {
    assert.deepEqual(buttonsOf(migrated), [
      "home/h-cue:cue-button",
      "home/h-lights:cue-button",
      "v-booth/b-cue:cue-button",
      "v-booth/b-proj:cue-button",
      "v-booth/b-shutter:cue-button",
      "v-foh/f-rec:cue-button",
      "v-foh/f-shutter:cue-button",
    ]);
  });

  test("each is bound to its own rule, named btn_<slug>, unique, and a pair-looking name gets _cue", () => {
    assert.deepEqual(
      [
        ["home", "h-lights"],
        ["v-booth", "b-shutter"],
        ["v-booth", "b-proj"],
        ["v-foh", "f-shutter"],
        ["v-foh", "f-rec"],
      ].map(([v, o]) => `${v}/${o} -> ${cueOf(migrated, v!, o!)}`),
      [
        "home/h-lights -> btn_lights",
        "v-booth/b-shutter -> btn_shutter",
        "v-booth/b-proj -> btn_projectors_on_cue",
        "v-foh/f-shutter -> btn_shutter_2",
        // The legacy label "Action" names nothing: the action's own name does.
        `v-foh/f-rec -> btn_${AUTOMATION_ACTIONS["obs.record"]!.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      ],
    );
  });

  test("each rule carries the stored action and params, and is a hidden, enabled, un-cooled Called-by-name rule", () => {
    const press = ruleFor(rules, "v-booth", "b-shutter")!;
    assert.deepEqual(press.action, { id: "companion.press", params: { pageId: "page-opaque", page: 1, row: 2, col: 3, label: "Shutter" } });
    assert.deepEqual(press.trigger, { id: "call.by-name", params: { name: "btn_shutter", homeAssistant: "hidden" } });
    assert.deepEqual([press.enabled, press.cooldownSec, press.oncePerService, press.conditions], [true, 0, false, []]);
    assert.deepEqual(press.ownedBy, { viewId: "v-booth", objectId: "b-shutter" });
    // The embedded view's, two containers down.
    assert.deepEqual(ruleFor(rules, "v-foh", "f-rec")!.action, { id: "obs.record", params: { mode: "toggle" } });
    // An action the registry does not have still migrates, as that id. Params the
    // rule cannot hold (a boolean) are the one thing not carried.
    assert.deepEqual(ruleFor(rules, "home", "h-lights")!.action, { id: "gone.action", params: { room: "foyer", level: 3 } });
  });

  test("the Button keeps its label, position, size and style", () => {
    const home = migrated.find((v) => v.id === "home")!.layout!.objects.find((o) => o.id === "h-lights")!;
    assert.deepEqual(home.config, { type: "cue-button", cue: "btn_lights", label: "Lights" });
    assert.deepEqual([home.x, home.y, home.w, home.h, home.z], [0.1, 0.1, 0.2, 0.1, 1]);
    assert.equal(home.style?.background, "#112233");
    const booth = migrated.find((v) => v.id === "v-booth")!.layout!.objects.find((o) => o.id === "b-shutter")!;
    assert.equal(booth.style?.cornerRadius, 7);
    // A cue Button that was already there is untouched, and so is the embed.
    assert.equal(cueOf(migrated, "home", "h-cue"), "projectors");
    assert.equal(rules.length, 5, "exactly one rule per migrated Button");
  });

  test("the views were written and one line said how many and where", async () => {
    assert.deepEqual(buttonsOf(await viewsStore.load()), buttonsOf(migrated));
    const said = lines.filter((l) => l.includes("Run an action button"));
    assert.deepEqual(said, [
      "[automation] migrated 5 Run an action buttons to their own cues (Home 1, Booth console 2, FOH iPad 2)",
    ]);
  });

  test("a second load converts nothing, says nothing and writes no rules", async (t) => {
    const again = captureConsole(t, "log");
    await runLoadPass(await viewsStore.load(), []);
    assert.deepEqual(again.filter((l) => l.includes("Run an action button")), []);
    assert.equal((await automationStore.loadRules()).length, 5);
  });

  test("a Run an action Button saved AFTER the first start is converted at the next one", async (t) => {
    // The layout editor can still make these, so a once-per-install pass would
    // leave this one ignoring Simulate and Disarm for good.
    const first = await viewsStore.load();
    const added = first.map((v) =>
      v.id !== "v-booth" || !v.layout
        ? v
        : {
            ...v,
            layout: {
              ...v.layout,
              objects: [
                ...v.layout.objects,
                { id: "b-late", ...place, config: { type: "action-button", actionId: "obs.record", params: {}, label: "Late" } },
              ],
            },
          },
    ) as unknown as View[];
    await viewsStore.save(added);
    const lines = captureConsole(t, "log");
    const out = await runLoadPass(await viewsStore.load(), []);
    assert.equal(buttonsOf(out.views).filter((b) => b.endsWith(":action-button")).length, 0, "the late Button was left as Run an action");
    assert.ok(cueOf(out.views, "v-booth", "b-late"), "and has no cue");
    assert.equal((await automationStore.loadRules()).length, 6);
    assert.deepEqual(lines.filter((l) => l.includes("Run an action button")), [
      "[automation] migrated 1 Run an action button to its own cue (Booth console 1)",
    ]);
  });
});

describe("a settings.json from an earlier beta", () => {
  test("still carries the retired actionButtonsMigrated flag, which changes nothing", async () => {
    await settingsStore.patch({ actionButtonsMigrated: true } as never);
    await automationStore.saveRules([]);
    await viewsStore.save(fixtureViews());
    const out = await runLoadPass(await viewsStore.load(), []);
    assert.equal(buttonsOf(out.views).filter((b) => b.endsWith(":action-button")).length, 0, "the stale flag skipped the pass");
    assert.equal((await automationStore.loadRules()).length, 5);
  });
});

describe("planning the migration", () => {
  test("two views with the same name are counted as two, each under its own id", () => {
    const view = (id: string, objectId: string) =>
      ({
        id,
        name: "Console",
        kind: "custom",
        createdAt: "",
        layout: {
          version: 1,
          canvas: { width: 1920, height: 1080, background: null, fit: "responsive" },
          objects: [{ id: objectId, ...place, config: { type: "action-button", actionId: "obs.record", params: {}, label: `Rec ${objectId}` } }],
        },
      }) as unknown as View;
    const plan = planActionButtonMigration([view("v-a", "o-a"), view("v-b", "o-b")], [], () => undefined);
    assert.equal(plan.count, 2);
    assert.deepEqual(plan.perView, [
      { viewName: "Console", count: 1 },
      { viewName: "Console", count: 1 },
    ]);
  });
});

describe("the rule a Button's action becomes", () => {
  const action = { id: "obs.record", params: { mode: "toggle" } };

  test("a manual cue (make it a cue) says its name, has its cooldown, belongs to nobody and is hidden from Home Assistant", () => {
    const rule = buttonCueRule({ name: "Rec", cueName: "rec", action, says: "Rec", cooldownSec: 2 });
    assert.deepEqual(rule, {
      name: "Rec",
      enabled: true,
      trigger: { id: "call.by-name", params: { name: "rec", says: "Rec", homeAssistant: "hidden" } },
      conditions: [],
      action,
      cooldownSec: 2,
      oncePerService: false,
    });
    assert.equal("ownedBy" in rule, false);
  });

  test("a migrated Button's rule belongs to it, says nothing of its own and is never cooled down", () => {
    const rule = buttonCueRule({ name: "Rec", cueName: "btn_rec", action, ownedBy: { viewId: "v", objectId: "o" } });
    assert.deepEqual(rule.ownedBy, { viewId: "v", objectId: "o" });
    assert.equal(rule.cooldownSec, 0);
    assert.deepEqual(rule.trigger.params, { name: "btn_rec", homeAssistant: "hidden" });
  });
});

describe("migrating when something goes wrong", () => {
  test("an interrupted pass (rules written, views not) converts the Buttons next time WITHOUT a second rule each", async (t) => {
    await automationStore.saveRules([]);
    await viewsStore.save(fixtureViews());
    const realSave = viewsStore.save.bind(viewsStore);
    viewsStore.save = (async () => {
      throw new Error("disk full");
    }) as typeof viewsStore.save;
    try {
      // The views are what failed; the error says the rules DID land.
      await assert.rejects(
        runLoadPass(await viewsStore.load(), []),
        /5 cues for Run an action buttons were saved, but views\.json was not: disk full/,
      );
    } finally {
      viewsStore.save = realSave;
    }
    assert.equal((await automationStore.loadRules()).length, 5);
    assert.ok(buttonsOf(await viewsStore.load()).some((b) => b.endsWith(":action-button")), "the views changed on disk");

    const lines = captureConsole(t, "log");
    const out = await runLoadPass(await viewsStore.load(), []);
    assert.equal(buttonsOf(out.views).filter((b) => b.endsWith(":action-button")).length, 0);
    assert.equal((await automationStore.loadRules()).length, 5, "the second run made a second rule per Button");
    assert.equal(cueOf(out.views, "v-booth", "b-shutter"), "btn_shutter", "and bound to the first run's rule");
    assert.equal(lines.filter((l) => l.includes("Run an action button")).length, 1);
  });

  test("rules that cannot be saved leave the Buttons as they were, and say so", async (t) => {
    await automationStore.saveRules([]);
    await viewsStore.save(fixtureViews());
    const real = automationStore.saveRules.bind(automationStore);
    automationStore.saveRules = async () => {
      throw new Error("read-only file system");
    };
    const lines = captureConsole(t, "log", "error");
    try {
      const out = await runLoadPass(await viewsStore.load(), []);
      assert.equal(buttonsOf(out.views).filter((b) => b.endsWith(":action-button")).length, 5, "a Button was converted without its rule");
    } finally {
      automationStore.saveRules = real;
    }
    assert.ok(
      lines.some((l) => l.includes("[automation]") && l.includes("were not converted") && l.includes("read-only file system")),
      `nothing said the Buttons were left alone: ${JSON.stringify(lines)}`,
    );
    assert.equal((await automationStore.loadRules()).length, 0);
  });

  test("an owned rule with no cue name does not bind its Button: the Button gets a cue that has a name", async () => {
    await automationStore.saveRules([
      {
        id: "hand-edited",
        name: "Hand edited",
        enabled: true,
        trigger: { id: "call.by-name", params: { name: "" } },
        conditions: [],
        action: { id: "log.message", params: { message: "x" } },
        cooldownSec: 0,
        oncePerService: false,
        ownedBy: { viewId: "v-booth", objectId: "b-shutter" },
      },
    ]);
    await viewsStore.save(fixtureViews());
    const out = await runLoadPass(await viewsStore.load(), []);
    assert.equal(cueOf(out.views, "v-booth", "b-shutter"), "btn_shutter", "the Button was bound to the unnamed rule");
    const bound = (await automationStore.loadRules()).filter((r) => r.ownedBy?.objectId === "b-shutter");
    assert.deepEqual(bound.map((r) => r.trigger.params.name).sort(), ["", "btn_shutter"]);
  });

  test("an install with no Run an action Buttons logs nothing", async (t) => {
    await viewsStore.save([]);
    const lines = captureConsole(t, "log");
    await runLoadPass([], []);
    assert.deepEqual(lines.filter((l) => l.includes("Run an action")), []);
  });
});

// ── The rules routes ──────────────────────────────────────────────────────────

/** Rules routes need a started engine; the migration above left five rules in the store. */
async function startEngine(): Promise<void> {
  await automationStore.saveRules([]);
  await viewsStore.save(fixtureViews());
  await runLoadPass(await viewsStore.load(), []);
  await automationEngine.init();
}

const api = (route: typeof automationRoutes, pathname: string, method = "GET", body?: unknown) =>
  callRoute(route, pathname, { method, headers: browser, ...(body === undefined ? {} : { body }) });

describe("a rule that belongs to a Button", () => {
  before(startEngine);

  test("the rules list returns ownedBy, and no ownerMissing while the Button is there", async () => {
    const list = (await api(automationRoutes, "/api/automation/rules")).json as { rules: (Rule & { ownerMissing?: true })[] };
    const owned = list.rules.filter((r) => r.ownedBy);
    assert.equal(owned.length, 5);
    assert.deepEqual(owned.filter((r) => r.ownerMissing), []);
  });

  test("a rule with ownedBy is refused, with a sentence, on any trigger but Called by name", async () => {
    const r = await api(automationRoutes, "/api/automation/rules", "POST", {
      name: "Owned, but timed",
      enabled: false,
      trigger: { id: "service.started", params: {} },
      conditions: [],
      action: { id: "log.message", params: { message: "x" } },
      cooldownSec: 0,
      oncePerService: false,
      ownedBy: { viewId: "v-booth", objectId: "b-new" },
    });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /has to stay Called by name/);
  });

  test("an owned rule cannot be re-triggered by a patch either", async () => {
    const list = (await api(automationRoutes, "/api/automation/rules")).json as { rules: Rule[] };
    const owned = list.rules.find((r) => r.ownedBy?.objectId === "b-shutter")!;
    const r = await api(automationRoutes, `/api/automation/rules/${owned.id}`, "PATCH", {
      trigger: { id: "service.started", params: {} },
    });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /has to stay Called by name/);
    assert.equal(
      (automationEngine.listRules().find((x) => x.id === owned.id)!).trigger.id,
      "call.by-name",
      "the refusal still changed the rule",
    );
  });

  test("ownedBy that is not two pieces of text is refused", async () => {
    const r = await api(automationRoutes, "/api/automation/rules", "POST", {
      name: "Owned by nobody",
      enabled: false,
      trigger: { id: "call.by-name", params: { name: "owned_by_nobody" } },
      conditions: [],
      action: { id: "log.message", params: { message: "x" } },
      cooldownSec: 0,
      oncePerService: false,
      ownedBy: { viewId: "v-booth" },
    });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /viewId and an objectId/);
  });

  test("a PATCH whose ownedBy is a falsy non-null value is refused, not reported as saved", async () => {
    const list = (await api(automationRoutes, "/api/automation/rules")).json as { rules: Rule[] };
    const owned = list.rules.find((r) => r.ownedBy?.objectId === "b-shutter")!;
    for (const bad of ["", false, 0]) {
      const r = await api(automationRoutes, `/api/automation/rules/${owned.id}`, "PATCH", { ownedBy: bad });
      assert.equal(r.status, 400, `ownedBy ${JSON.stringify(bad)} was accepted`);
      assert.match((r.json as { error: string }).error, /viewId and an objectId/);
      assert.deepEqual(
        automationEngine.listRules().find((x) => x.id === owned.id)!.ownedBy,
        { viewId: "v-booth", objectId: "b-shutter" },
        `ownedBy ${JSON.stringify(bad)} changed the rule`,
      );
    }
  });

  test("a new owned rule is accepted and returned with ownedBy, and null clears it", async () => {
    const made = await api(automationRoutes, "/api/automation/rules", "POST", {
      name: "Made for a Button",
      enabled: true,
      trigger: { id: "call.by-name", params: { name: "btn_made", homeAssistant: "hidden" } },
      conditions: [],
      action: { id: "log.message", params: { message: "x" } },
      cooldownSec: 0,
      oncePerService: false,
      ownedBy: { viewId: "v-booth", objectId: "b-shutter" },
    });
    assert.equal(made.status, 201);
    const rule = made.json as Rule;
    assert.deepEqual(rule.ownedBy, { viewId: "v-booth", objectId: "b-shutter" });

    const released = await api(automationRoutes, `/api/automation/rules/${rule.id}`, "PATCH", { ownedBy: null });
    assert.equal(released.status, 200);
    assert.equal("ownedBy" in (released.json as object), false);
    assert.equal("ownedBy" in automationEngine.listRules().find((r) => r.id === rule.id)!, false, "null was stored");
    // Released, it may be anything a rule may be.
    const retriggered = await api(automationRoutes, `/api/automation/rules/${rule.id}`, "PATCH", {
      trigger: { id: "service.started", params: {} },
    });
    assert.equal(retriggered.status, 200);
    await automationEngine.removeRule(rule.id);
  });

  test("a restored rules file with an owned rule on another trigger is refused", () => {
    const [problem] = automationEngine.cueProblemsIn([
      {
        id: "r1",
        name: "Owned, timed",
        enabled: true,
        trigger: { id: "service.started", params: {} },
        conditions: [],
        action: { id: "log.message", params: {} },
        cooldownSec: 0,
        oncePerService: false,
        ownedBy: { viewId: "v", objectId: "o" },
      },
    ]);
    assert.match(problem?.problem ?? "", /has to stay Called by name/);
  });
});

// ── A migrated Button's press ─────────────────────────────────────────────────

describe("pressing a migrated Button's cue through POST /api/cues/<name>", () => {
  before(startEngine);

  const press = () => callRoute(cueRoutes, "/api/cues/btn_shutter", { method: "POST", headers: browser });

  test("with Simulate on it is simulated and presses nothing", async () => {
    presses = [];
    await automationEngine.setSettings({ simulate: true, disarmed: false });
    const r = await press();
    assert.equal(r.status, 200);
    assert.equal((r.json as { simulated?: true }).simulated, true);
    assert.deepEqual(presses, []);
  });

  test("with Disarm on it is refused and presses nothing", async () => {
    presses = [];
    await automationEngine.setSettings({ simulate: false, disarmed: true });
    const r = await press();
    assert.equal(r.status, 409);
    assert.equal((r.json as { reason: string }).reason, "disarmed");
    assert.deepEqual(presses, []);
  });

  test("with both off it presses Companion's button at the migrated coordinates, and a second press at once is not cooled down", async () => {
    presses = [];
    await automationEngine.setSettings({ simulate: false, disarmed: false });
    assert.equal((await press()).status, 200);
    assert.equal((await press()).status, 200, "an owned cue has no cooldown");
    assert.deepEqual(presses, [
      "http://10.0.0.5:8000/api/location/1/2/3/press",
      "http://10.0.0.5:8000/api/location/1/2/3/press",
    ]);
  });
});

// ── Where a cue is used ───────────────────────────────────────────────────────

describe("GET /api/cues/usage", () => {
  before(startEngine);

  /** One line per reference, in the order the route returned them. */
  const lines = (usage: Record<string, { viewId: string; viewName: string; objectId: string; label: string; home: boolean }[]>): string[] =>
    Object.entries(usage).flatMap(([cue, uses]) =>
      uses.map((u) => `${cue} | ${u.viewId} | ${u.viewName} | ${u.objectId} | ${JSON.stringify(u.label)} | home=${u.home}`),
    );

  test("lists every Button's cue, Home and containers and embedded views included, sorted", async () => {
    const r = await callRoute(cueRoutes, "/api/cues/usage");
    assert.equal(r.status, 200);
    assert.deepEqual(lines(r.json as never), [
      'btn_lights | home | Home | h-lights | "Lights" | home=true',
      'btn_obs_recording | v-foh | FOH iPad | f-rec | "Action" | home=false',
      'btn_projectors_on_cue | v-booth | Booth console | b-proj | "Projectors ON" | home=false',
      'btn_shutter | v-booth | Booth console | b-shutter | "Shutter" | home=false',
      'btn_shutter_2 | v-foh | FOH iPad | f-shutter | "Shutter" | home=false',
      'projectors | home | Home | h-cue | "Projectors" | home=true',
      'projectors | v-booth | Booth console | b-cue | "Same cue, nested" | home=false',
    ]);
  });

  test("a cue nothing uses is not in it, and a view with no layout is walked without a throw", async () => {
    await viewsStore.save([...(await viewsStore.load()), { id: "v-slots", name: "Slots", kind: "slots", createdAt: "" } as View]);
    const usage = (await callRoute(cueRoutes, "/api/cues/usage")).json as Record<string, unknown>;
    assert.equal("btn_unused" in usage, false);
    assert.equal(Object.keys(usage).length, 6);
  });

  test("a hand-written Button's cue is keyed the way the engine reads it: trimmed and lower-cased", async () => {
    const before = await viewsStore.load();
    const hand = (id: string, cue: string) => ({ id, ...place, config: { type: "cue-button", cue, label: id } });
    await viewsStore.save(
      before.map((v) =>
        v.id === "home"
          ? { ...v, layout: { ...v.layout!, objects: [...v.layout!.objects, hand("h-up", "Lights"), hand("h-low", " lights ")] as never } }
          : v,
      ),
    );
    try {
      const usage = (await callRoute(cueRoutes, "/api/cues/usage")).json as Record<string, { objectId: string }[]>;
      assert.equal("Lights" in usage, false, "the cue is keyed as stored, not as the engine reads it");
      assert.deepEqual(usage.lights?.map((u) => u.objectId), ["h-low", "h-up"]);
    } finally {
      await viewsStore.save(before);
    }
  });
});

// ── When the Button goes ──────────────────────────────────────────────────────

describe("a view saved without the Button that owns a rule", () => {
  before(startEngine);

  const without = (views: View[], objectId: string): View[] =>
    views.map((v) => {
      const drop = (objs: { id: string; children?: unknown[] }[]): unknown[] =>
        objs.filter((o) => o.id !== objectId).map((o) => (o.children ? { ...o, children: drop(o.children as never) } : o));
      return v.layout ? { ...v, layout: { ...v.layout, objects: drop(v.layout.objects as never) as never } } : v;
    });

  test("keeps the rule, logs it once, and lists it with ownerMissing", async (t) => {
    const lines = captureConsole(t, "log");
    await viewsStore.save(without(await viewsStore.load(), "b-shutter"));
    assert.deepEqual(
      lines.filter((l) => l.includes("belongs to a button that is gone")),
      ["[automation] btn_shutter belongs to a button that is gone (Booth console); kept, delete it from Automation"],
    );
    assert.ok(ruleFor(automationEngine.listRules(), "v-booth", "b-shutter"), "the rule was deleted");
    const list = (await api(automationRoutes, "/api/automation/rules")).json as { rules: (Rule & { ownerMissing?: true })[] };
    assert.deepEqual(
      list.rules.filter((r) => r.ownerMissing).map((r) => r.trigger.params.name),
      ["btn_shutter"],
    );
    // Computed, never stored.
    assert.equal(
      automationEngine.listRules().some((r) => "ownerMissing" in r),
      false,
    );
  });

  test("and does not say it again on a later save of anything", async (t) => {
    const lines = captureConsole(t, "log");
    await viewsStore.save(await viewsStore.load());
    await viewsStore.save(without(await viewsStore.load(), "h-cue"));
    assert.deepEqual(lines.filter((l) => l.includes("belongs to a button that is gone")), []);
  });

  test("deleting the whole view says it with the view's name", async (t) => {
    const lines = captureConsole(t, "log");
    await viewsStore.save((await viewsStore.load()).filter((v) => v.id !== "v-foh"));
    assert.deepEqual(
      lines.filter((l) => l.includes("belongs to a button that is gone")).sort(),
      [
        `[automation] ${AUTOMATION_RECORD_CUE()} belongs to a button that is gone (FOH iPad); kept, delete it from Automation`,
        "[automation] btn_shutter_2 belongs to a button that is gone (FOH iPad); kept, delete it from Automation",
      ].sort(),
    );
    assert.equal(automationEngine.listRules().filter((r) => r.ownedBy?.viewId === "v-foh").length, 2, "a rule went with its view");
  });

  test("a Button re-pointed at another cue no longer owns its rule", async (t) => {
    const lines = captureConsole(t, "log");
    const views = (await viewsStore.load()).map((v) =>
      v.id === "v-booth"
        ? ({
            ...v,
            layout: {
              ...v.layout!,
              objects: v.layout!.objects.map((o) => ({
                ...o,
                children: o.children?.map((c) => (c.id === "b-proj" ? { ...c, config: { type: "cue-button", cue: "somewhere_else" } } : c)),
              })),
            },
          } as View)
        : v,
    );
    await viewsStore.save(views);
    assert.deepEqual(
      lines.filter((l) => l.includes("belongs to a button that is gone")),
      ["[automation] btn_projectors_on_cue belongs to a button that is gone (Booth console); kept, delete it from Automation"],
    );
  });

  test("deleting a view whose duplicate still has the Button is not a Button gone", async (t) => {
    await automationEngine.addRule({
      name: "Duplicated",
      enabled: true,
      trigger: { id: "call.by-name", params: { name: "btn_duplicated", homeAssistant: "hidden" } },
      conditions: [],
      action: { id: "log.message", params: { message: "x" } },
      cooldownSec: 0,
      oncePerService: false,
      ownedBy: { viewId: "v-dup", objectId: "d-1" },
    });
    const dup = (id: string, name: string) =>
      ({
        id,
        name,
        layout: { objects: [{ id: "d-1", x: 0, y: 0, w: 10, h: 10, config: { type: "cue-button", cue: "btn_duplicated" } }] },
      }) as unknown as View;
    await viewsStore.save([...(await viewsStore.load()), dup("v-dup", "Original"), dup("v-dup-copy", "Original copy")]);
    const lines = captureConsole(t, "log");
    await viewsStore.save((await viewsStore.load()).filter((v) => v.id !== "v-dup"));
    assert.deepEqual(lines.filter((l) => l.includes("btn_duplicated")), []);
    const list = (await api(automationRoutes, "/api/automation/rules")).json as { rules: (Rule & { ownerMissing?: true })[] };
    assert.equal(list.rules.find((r) => r.trigger.params.name === "btn_duplicated")?.ownerMissing, undefined);
  });

  test("a rule written before its Button was saved is not reported by an unrelated save", async (t) => {
    // The inspector writes the rule when the pick is made and the layout later.
    await automationEngine.addRule({
      name: "Not saved yet",
      enabled: true,
      trigger: { id: "call.by-name", params: { name: "btn_not_saved_yet", homeAssistant: "hidden" } },
      conditions: [],
      action: { id: "log.message", params: { message: "x" } },
      cooldownSec: 0,
      oncePerService: false,
      ownedBy: { viewId: "v-booth", objectId: "b-not-yet" },
    });
    const lines = captureConsole(t, "log");
    await viewsStore.save(await viewsStore.load());
    assert.deepEqual(lines.filter((l) => l.includes("btn_not_saved_yet")), []);
  });
});

/** The cue name the migration gave the obs.record Button. */
function AUTOMATION_RECORD_CUE(): string {
  return automationEngine.listRules().find((r) => r.ownedBy?.objectId === "f-rec")!.trigger.params.name as string;
}

describe("a layout saved with a Run an action Button in it", () => {
  before(startEngine);

  test("is converted on save, with its own owned rule and one logged line, as at start-up", async (t) => {
    // An older tab sends the type back; the next start may be weeks away.
    const held = stageController as unknown as { state: { views: View[] } };
    held.state = { ...held.state, views: await viewsStore.load() };
    const lines = captureConsole(t, "log");
    const booth = (await viewsStore.load()).find((v) => v.id === "v-booth")!;
    const layout = {
      ...booth.layout!,
      objects: [
        ...booth.layout!.objects,
        { id: "late-act", x: 0.5, y: 0.5, w: 0.2, h: 0.1, z: 9, config: { type: "action-button", actionId: "obs.record", params: { mode: "toggle" }, label: "Late" } },
      ],
    };
    await stageController.setViewLayout("v-booth", layout as never);
    const saved = (await viewsStore.load()).find((v) => v.id === "v-booth")!.layout!.objects.find((o) => o.id === "late-act")!;
    assert.equal((saved.config as { type: string }).type, "cue-button", "the saved layout still holds the old type");
    // In the RUNNING engine, not only on disk: a Button bound to a cue the engine does not know refuses every press.
    const rule = ruleFor(automationEngine.listRules(), "v-booth", "late-act");
    assert.ok(rule, "no rule of its own was made, or the engine was not told");
    assert.ok((await automationStore.loadRules()).some((r) => r.id === rule.id), "the rule is not on disk");
    assert.deepEqual(rule.action, { id: "obs.record", params: { mode: "toggle" } });
    assert.equal((saved.config as { cue: string }).cue, String(rule.trigger.params.name));
    assert.deepEqual(lines.filter((l) => l.includes("on save")), ["[automation] converted 1 Run an action button to its own cue on save (Booth console 1)"]);
  });
});
