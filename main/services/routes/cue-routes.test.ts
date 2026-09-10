// Calling a cue: the gate, the guards, and the answers a voice assistant reads.
//
// Everything here runs the REAL route module against the real engine through
// route-harness, so these are the bytes a caller gets. The only stub is
// Companion's own HTTP API — a test that presses a button turns something on in
// a building.
//
// Four things are guarded that have no other check anywhere:
//
//  - a call with no token is 401. Without it, "anyone who can reach the port"
//    can turn the projectors off during a service from a phone on the guest wifi.
//  - `call.by-name` never fires from the bus. A cue that fired itself because a
//    snapshot changed is the failure this whole feature must not have.
//  - the cooldown applies to a CALL, not just to a triggered fire. A voice
//    assistant that mishears "again" is a double press.
//  - `POST /api/action/invoke` with no Origin needs a token, while the app's own
//    same-origin page still works. Half of that is easy to break silently.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), "cue-routes-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { cueRoutes } = await import("./cue-routes.js");
const { automationRoutes } = await import("./automation-routes.js");
const { callRoute } = await import("./route-harness.js");
const { automationEngine } = await import("../automation-engine.js");
const { automationLog } = await import("../automation-log.js");
const { cueTokens } = await import("../cue-tokens.js");
const { companionApi, companionDeps } = await import("../companion-api.js");
const { companionExportFixture, FIXTURE_PAGES, FIXTURE_PAGE_IDS, fixtureActionId } = await import(
  "../fixtures/companion-export.js"
);
type CompanionButton = import("../companion-export.js").CompanionButton;
const { stageController } = await import("../stage-controller.js");
const { integrationManager } = await import("../integration-manager.js");
const { AUTOMATION_TRIGGERS, CALL_TRIGGER_ID } = await import("../automation-triggers.js");
const { readFingerprint } = await import("../companion-fingerprint.js");
const { runCompanionReconcile } = await import("../companion-reconcile.js");
const { cueStates } = await import("../cue-states.js");

after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Every press the stubbed Companion received. */
let presses: string[] = [];

/**
 * What the stubbed Companion's custom variables hold, and every read of one.
 *
 * A name that is not a key here answers 404, which is Companion's own answer
 * for a variable that does not exist.
 */
let variables: Record<string, string> = {};
let variableReads: string[] = [];

/**
 * A live PCO service, or none.
 *
 * stageController has no setter for this — nothing in production sets it from
 * outside — so the private fields are written directly. The alternative is a
 * production seam that exists only for a test, which is worse.
 */
function setPco(live: Record<string, unknown> | null, planTitle: string | null = null): void {
  const c = stageController as unknown as { lastLive: unknown; state: Record<string, unknown> };
  c.lastLive = live;
  c.state = { ...c.state, planTitle };
}

/** PCO answering, with nothing on. The baseline every cue needs to run. */
const setQuiet = () => setPco({ mode: "none", serviceTimeId: null, targetAt: null, serviceTimeStartsAt: null });
/** A plan item live. */
const setLive = (planTitle: string) => setPco({ mode: "item", serviceTimeId: "st-1" }, planTitle);

/**
 * Whether the Planning Center integration counts as set up.
 *
 * `service.is-not-live` fails closed only when PCO is CONFIGURED — an install
 * with no Planning Center at all must not have every cue refused forever — so
 * every case here has to say which it is. The manager has no setter for it
 * (nothing in production sets it from outside), so getStates is wrapped.
 */
type State = ReturnType<typeof integrationManager.getStates>[number];
const realGetStates = integrationManager.getStates.bind(integrationManager);
function setPcoConfigured(configured: boolean): void {
  integrationManager.getStates = () => {
    const states = realGetStates();
    // The manager reports nothing at all until it is initialised, which in this
    // suite it never is — so the row is added rather than patched.
    if (!states.some((s) => s.id === "planning-center")) {
      return [...states, { id: "planning-center", connection: "disconnected", configured } as State];
    }
    return states.map((s) => (s.id === "planning-center" ? { ...s, configured } : s));
  };
}

/**
 * A configured Companion row on the integration manager, for the duration of
 * one case.
 *
 * `integrationManager.test(id)` throws "Unknown integration" until the manager
 * has been initialised, and initialising it here would start every service in
 * the app. The row is seeded directly instead — the same reason the PCO state
 * above is written directly rather than through a production seam that exists
 * only for a test. Returns its own undo.
 */
function withCompanionRow(): () => void {
  const states = (integrationManager as unknown as { states: Map<string, unknown> }).states;
  const had = states.has("companion");
  const before = states.get("companion");
  states.set("companion", {
    id: "companion",
    connection: "disconnected",
    message: null,
    enabled: true,
    configured: true,
    config: { host: "10.0.0.5", port: 8000 },
  });
  return () => {
    if (had) states.set("companion", before);
    else states.delete("companion");
  };
}

let TOKEN = "";

/**
 * The default Companion stub: the export, a press, and a custom variable read.
 *
 * A function rather than an inline assignment because two describes below
 * replace `companionDeps.fetch` in their own `before` and never put it back —
 * so a describe that needs the variable read has to reinstall this. Found by a
 * custom-variable read being answered with the whole export document.
 */
function installCompanionStub(): void {
  companionDeps.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/press")) {
      presses.push(url);
      return new Response("ok", { status: 200 });
    }
    const variable = /\/api\/custom-variable\/([^/]+)\/value$/.exec(url);
    if (variable) {
      const name = decodeURIComponent(variable[1]!);
      variableReads.push(name);
      const value = variables[name];
      return value === undefined
        ? new Response("Not found", { status: 404 })
        : new Response(value, { status: 200 });
    }
    void init;
    return Response.json(companionExportFixture());
  };
}

before(async () => {
  companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
  installCompanionStub();
  await automationEngine.init();
  await automationEngine.setSettings({ simulate: false, disarmed: false });
  TOKEN = (await cueTokens.mint("Home Assistant")).secret;
});

/** A function, not a constant: TOKEN is minted in `before`, which runs after
 *  module scope. Captured as a constant it is "Bearer " and every case 401s. */
const auth = (): Record<string, string> => ({ authorization: `Bearer ${TOKEN}` });
/** What a browser on this server's own page sends on a POST or DELETE over plain
 *  HTTP on a LAN address: an Origin, and NO Sec-Fetch-Site — browsers send the
 *  Fetch-metadata headers only to HTTPS or localhost. This is what the operator's
 *  browser actually sends to a real install. */
const browser = {
  origin: "http://stage.local:8788",
  host: "stage.local:8788",
};

/** Wipe the rules and the log, then install one cue. */
async function withCue(over: Record<string, unknown> = {}): Promise<string> {
  for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
  await automationLog.clear();
  const rule = await automationEngine.addRule({
    name: "Projectors ON",
    enabled: true,
    trigger: { id: CALL_TRIGGER_ID, params: { name: "projectors_on", says: "the projectors" } },
    conditions: [{ id: "service.is-not-live", params: {} }],
    action: { id: "companion.press", params: { page: 17, row: 2, col: 6, label: "Projectors ON" } },
    cooldownSec: 0,
    oncePerService: false,
    ...over,
  });
  return rule.id;
}

/** A button offer's slug, as a string. */
const slugOf = (b: Record<string, unknown>): string => String(b.slug ?? "");

const call = (name: string, opts: Record<string, unknown> = {}) =>
  callRoute(cueRoutes, `/api/cues/${name}`, { method: "POST", headers: auth(), ...opts });

beforeEach(() => {
  presses = [];
  variables = {};
  variableReads = [];
  cueStates.invalidate();
  setQuiet();
  setPcoConfigured(true);
  companionApi.invalidate();
});

// ── The gate ──────────────────────────────────────────────────────────────────

describe("the token gate on a call", () => {
  test("no Authorization header is 401", async () => {
    await withCue();
    const r = await callRoute(cueRoutes, "/api/cues/projectors_on", { method: "POST" });
    assert.equal(r.status, 401);
    assert.equal(presses.length, 0, "nothing may be pressed before the caller is known");
  });

  test("a wrong token is 401, not 403 — we do not confirm the cue exists", async () => {
    await withCue();
    const r = await call("projectors_on", { headers: { authorization: "Bearer su_wrong" } });
    assert.equal(r.status, 401);
  });

  test("the refusal line says WHICH header problem it was", async () => {
    // Three refusals that read identically as a 401 and are fixed in three
    // different places. The log used to say "no valid token" for all of them.
    await withCue();
    const warns: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
    try {
      await callRoute(cueRoutes, "/api/cues/projectors_on", { method: "POST" });
      await call("projectors_on", { headers: { authorization: "su_bare_no_scheme" } });
      await call("projectors_on", { headers: { authorization: "Bearer su_wrong" } });
    } finally {
      console.warn = real;
    }
    const refusals = warns.filter((w) => w.includes("[cues] refused"));
    assert.equal(refusals.length, 3, `expected three refusal lines, got ${JSON.stringify(warns)}`);
    assert.match(refusals[0]!, /no Authorization header/);
    assert.match(refusals[1]!, /not "Bearer <token>"/);
    assert.match(refusals[2]!, /not recognised/);
    assert.equal(refusals.some((w) => w.includes("su_wrong") || w.includes("su_bare")), false, "a refusal line carried the token");
  });

  test("a same-origin browser does NOT get a free pass on a call", async () => {
    // Deliberately unlike the management routes. There is no operator-at-the-
    // console case for firing a cue; the rule editor has a Test button.
    await withCue();
    const r = await callRoute(cueRoutes, "/api/cues/projectors_on", {
      method: "POST",
      headers: browser,
    });
    assert.equal(r.status, 401);
  });

  test("simulate mode answers 200 but SAYS it was simulated", async () => {
    // Simulate is on by default on a fresh install. A plain 200 here is a Home
    // Assistant switch that flips with the projectors still off.
    await withCue();
    await automationEngine.setSettings({ simulate: true });
    const r = await call("projectors_on");
    await automationEngine.setSettings({ simulate: false });

    assert.equal(r.status, 200);
    const body = r.json as { ok: boolean; detail: string; simulated?: true };
    assert.equal(body.simulated, true);
    assert.match(body.detail, /^would press/);
    assert.equal(presses.length, 0);
  });

  test("a valid token fires it", async () => {
    await withCue();
    const r = await call("projectors_on");
    assert.equal(r.status, 200);
    assert.deepEqual((r.json as { ok: boolean }).ok, true);
    assert.deepEqual(presses, ["http://10.0.0.5:8000/api/location/17/2/6/press"]);
  });
});

// ── The same-origin exemption on the management writes ────────────────────────

describe("the browser exemption is an Origin naming this server", () => {
  // Two mistakes, in order. First the exemption accepted `Sec-Fetch-Site:
  // same-origin` ALONE, and curl with that header minted a token. Then it
  // required Sec-Fetch-Site AND Origin — and a real operator's browser on a
  // plain-HTTP LAN install never sends Sec-Fetch-Site at all (browsers send it
  // only to HTTPS or localhost), so the settings page answered 401 to its own
  // import. The rule now: an Origin naming this server, and if Sec-Fetch-Site
  // is present it must agree.
  const mint = (headers: Record<string, string>) =>
    callRoute(cueRoutes, "/api/cues/tokens", {
      method: "POST",
      headers,
      body: { label: "curl" },
    });

  test("Sec-Fetch-Site alone is 401", async () => {
    const r = await mint({ "sec-fetch-site": "same-origin", host: "stage.local:8788" });
    assert.equal(r.status, 401);
  });

  test("a matching Origin with no Sec-Fetch-Site is allowed — that is a browser on plain HTTP", async () => {
    const r = await mint(browser);
    assert.equal(r.status, 201, "the settings page on a LAN install answered 401 to its own write");
    await callRoute(cueRoutes, `/api/cues/tokens/${(r.json as { token: { id: string } }).token.id}`, {
      method: "DELETE",
      headers: browser,
    });
  });

  test("a matching Origin with Sec-Fetch-Site: same-origin is allowed — a browser on localhost or HTTPS", async () => {
    const r = await mint({ ...browser, "sec-fetch-site": "same-origin" });
    assert.equal(r.status, 201);
    await callRoute(cueRoutes, `/api/cues/tokens/${(r.json as { token: { id: string } }).token.id}`, {
      method: "DELETE",
      headers: browser,
    });
  });

  test("an Origin naming somebody else is 401 here, and 403 before it ever arrives", async () => {
    // remote-server refuses a cross-origin write with 403 before routing (see
    // remote-server.test.ts for that matrix). This is the second line: even if it
    // did arrive, the exemption does not apply to it.
    const r = await mint({
      "sec-fetch-site": "same-origin",
      origin: "https://evil.example",
      host: "stage.local:8788",
    });
    assert.equal(r.status, 401);
  });

  test("a browser that says cross-site is believed, whatever its Origin says", async () => {
    const r = await mint({
      "sec-fetch-site": "cross-site",
      origin: "http://stage.local:8788",
      host: "stage.local:8788",
    });
    assert.equal(r.status, 401);
  });

  test("`same-site` is not `same-origin`", async () => {
    const r = await mint({
      "sec-fetch-site": "same-site",
      origin: "http://stage.local:8788",
      host: "stage.local:8788",
    });
    assert.equal(r.status, 401);
  });

  test("the same rule covers revoke, import-pairs and buttons/refresh", async () => {
    const half = { "sec-fetch-site": "same-origin", host: "stage.local:8788" };
    assert.equal(
      (await callRoute(cueRoutes, "/api/cues/tokens/whatever", { method: "DELETE", headers: half })).status,
      401,
    );
    assert.equal(
      (await callRoute(cueRoutes, "/api/companion/buttons/refresh", { method: "POST", headers: half })).status,
      401,
    );
    assert.equal(
      (await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
        method: "POST",
        headers: half,
        body: { pairs: [] },
      })).status,
      401,
    );
    // And each of them works for the app's own page.
    assert.equal(
      (await callRoute(cueRoutes, "/api/companion/buttons/refresh", { method: "POST", headers: browser })).status,
      200,
    );
  });
});

// ── The guards ────────────────────────────────────────────────────────────────

describe("guards on a call", () => {
  test("an unknown name is 404", async () => {
    await withCue();
    const r = await call("nothing_by_that_name");
    assert.equal(r.status, 404);
    assert.equal((r.json as { reason: string }).reason, "unknown");
  });

  test("a live service is 409, with a sentence an assistant can say", async () => {
    await withCue();
    setLive("The Gospel Way");
    const r = await call("projectors_on");
    assert.equal(r.status, 409);
    const body = r.json as { error: string; reason: string; plan: string };
    assert.equal(body.reason, "service-live");
    assert.equal(body.error, "The Gospel Way is live");
    assert.equal(body.plan, "The Gospel Way");
    assert.equal(presses.length, 0);
  });

  test("a disabled rule is 409, not 404 — the cue exists, it is switched off", async () => {
    await withCue({ enabled: false });
    const r = await call("projectors_on");
    assert.equal(r.status, 409);
    assert.equal((r.json as { reason: string }).reason, "disabled");
  });

  test("THE COOLDOWN: a second call inside it is 409 and presses nothing", async () => {
    await withCue({ cooldownSec: 60 });
    assert.equal((await call("projectors_on")).status, 200);

    const second = await call("projectors_on");
    assert.equal(second.status, 409, "a repeat inside the cooldown must be refused");
    assert.equal((second.json as { reason: string }).reason, "cooldown");
    assert.match((second.json as { error: string }).error, /try again in \d+ seconds?/);
    assert.equal(presses.length, 1, "exactly one press reached Companion");
  });

  test("disarmed refuses everything, cue or not", async () => {
    await withCue();
    await automationEngine.setSettings({ disarmed: true });
    const r = await call("projectors_on");
    await automationEngine.setSettings({ disarmed: false });
    assert.equal(r.status, 409);
    assert.equal((r.json as { reason: string }).reason, "disarmed");
  });
});

describe("what Planning Center says, and failing closed", () => {
  // The condition every imported cue carries. It was `mode !== "item"`, which
  // held ten minutes before a service and held whenever PCO could not be read —
  // the two moments a lighting shutdown is most likely to be asked for by
  // mistake. A wrong cue during setup is worse than a cue that does not fire.
  const HOUR = 60 * 60_000;

  test("preservice inside the hour is 409, and says so", async () => {
    await withCue();
    setPco(
      { mode: "preservice", serviceTimeId: "st-1", targetAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      "The Gospel Way",
    );
    const r = await call("projectors_on");
    assert.equal(r.status, 409);
    const body = r.json as { reason: string; error: string; plan: string };
    assert.equal(body.reason, "service-live");
    assert.equal(body.error, "The Gospel Way is about to start");
    assert.equal(body.plan, "The Gospel Way");
    assert.equal(presses.length, 0);
  });

  test("preservice for a service days away still runs — PCO reports it all week", async () => {
    await withCue();
    setPco(
      { mode: "preservice", serviceTimeId: "st-1", targetAt: new Date(Date.now() + 6 * 24 * HOUR).toISOString() },
      "Next Sunday",
    );
    assert.equal((await call("projectors_on")).status, 200);
  });

  test("no PCO state at all, with Planning Center configured, is 409", async () => {
    await withCue();
    setPco(null);
    const r = await call("projectors_on");
    assert.equal(r.status, 409);
    assert.equal((r.json as { reason: string }).reason, "planning-center-unknown");
    assert.match((r.json as { error: string }).error, /Planning Center is not answering/);
    assert.equal(presses.length, 0);
  });

  test("no PCO state and no Planning Center configured runs — there is nothing to check", async () => {
    await withCue();
    setPco(null);
    setPcoConfigured(false);
    assert.equal((await call("projectors_on")).status, 200);
  });
});

describe("oncePerService on a CALL", () => {
  test("the second call in the same service occurrence is 409", async () => {
    // Silently ignored before: the flag was read from the rule for a triggered
    // fire and nowhere on this path, so "the announcement, once" ran as often as
    // anybody asked.
    await withCue({ oncePerService: true });
    // Quiet, but with a service occurrence to key on: a Tuesday rehearsal with
    // Sunday's plan loaded is exactly this.
    setPco({
      mode: "preservice",
      serviceTimeId: "st-42",
      targetAt: new Date(Date.now() + 4 * 24 * 60 * 60_000).toISOString(),
    });

    assert.equal((await call("projectors_on")).status, 200);
    const second = await call("projectors_on");
    assert.equal(second.status, 409);
    assert.equal((second.json as { reason: string }).reason, "once-per-service");
    assert.equal(presses.length, 1, "exactly one press reached Companion");
  });

  test("a different service occurrence starts it over", async () => {
    await withCue({ oncePerService: true });
    const at = (id: string) =>
      setPco({
        mode: "preservice",
        serviceTimeId: id,
        targetAt: new Date(Date.now() + 4 * 24 * 60 * 60_000).toISOString(),
      });
    at("st-9am");
    assert.equal((await call("projectors_on")).status, 200);
    at("st-11am");
    assert.equal((await call("projectors_on")).status, 200);
    assert.equal(presses.length, 2);
  });
});

describe("confirmRequired", () => {
  test("the first call is 202 and presses nothing; the second, carrying the token, runs", async () => {
    await withCue({ confirmRequired: true });

    const first = await call("projectors_on");
    assert.equal(first.status, 202);
    const { confirm, expiresInSec } = first.json as { confirm: string; expiresInSec: number };
    assert.ok(confirm, "a confirmation token comes back");
    assert.equal(expiresInSec, 30);
    assert.equal(presses.length, 0);

    const second = await call(`projectors_on?confirm=${confirm}`);
    assert.equal(second.status, 200);
    assert.equal(presses.length, 1);
  });

  test("a wrong confirmation is refused and hands out a fresh one", async () => {
    await withCue({ confirmRequired: true });
    await call("projectors_on");
    const r = await call("projectors_on?confirm=not-the-token");
    assert.equal(r.status, 202);
    assert.equal(presses.length, 0);
  });

  test("a confirmation is SINGLE USE — replaying it hands out a fresh one and presses nothing", async () => {
    // Was untested: deleting the `pendingConfirm.delete` left the whole suite
    // green, so a voice assistant that retried a request (or anybody who read the
    // token out of a log) could fire the cue twice. The answer to a replay is
    // deliberately the same 202-with-a-new-token as any other unconfirmed call:
    // 409 would tell a caller which of its two problems it has, and there is
    // nothing useful it could do differently.
    const id = await withCue({ confirmRequired: true, cooldownSec: 0 });
    const first = await automationEngine.callByName("projectors_on", { caller: "test", now: 1_000 });
    assert.equal(first.status, 202);
    const token = (first.body as { confirm: string }).confirm;

    const used = await automationEngine.callByName("projectors_on", {
      caller: "test",
      confirm: token,
      now: 2_000,
    });
    assert.equal(used.status, 200);
    assert.equal(presses.length, 1);

    const replay = await automationEngine.callByName("projectors_on", {
      caller: "test",
      confirm: token,
      now: 3_000,
    });
    assert.equal(replay.status, 202, "a spent confirmation ran the cue again");
    assert.notEqual((replay.body as { confirm: string }).confirm, token, "the same token came back");
    assert.equal(presses.length, 1, "a replayed confirmation pressed a second time");
    void id;
  });

  test("a confirmation EXPIRES after 30 seconds", async () => {
    // Also untested. The window is the whole reason walking away cancels a cue;
    // without it a token minted before the service is still good after it.
    await withCue({ confirmRequired: true, cooldownSec: 0 });
    const first = await automationEngine.callByName("projectors_on", { caller: "test", now: 1_000 });
    const token = (first.body as { confirm: string }).confirm;

    const late = await automationEngine.callByName("projectors_on", {
      caller: "test",
      confirm: token,
      now: 1_000 + 30_001,
    });
    assert.equal(late.status, 202, "a lapsed confirmation still ran the cue");
    assert.equal(presses.length, 0);

    // One millisecond inside the window is still good, so the guard is testing
    // the boundary and not merely "expiry exists".
    const second = await automationEngine.callByName("projectors_on", { caller: "test", now: 100_000 });
    const fresh = (second.body as { confirm: string }).confirm;
    const inTime = await automationEngine.callByName("projectors_on", {
      caller: "test",
      confirm: fresh,
      now: 100_000 + 29_999,
    });
    assert.equal(inTime.status, 200);
    assert.equal(presses.length, 1);
  });

  test("the confirmation may arrive in the body, for Home Assistant", async () => {
    await withCue({ confirmRequired: true });
    const first = await call("projectors_on");
    const { confirm } = first.json as { confirm: string };
    const r = await call("projectors_on", { body: { confirm } });
    assert.equal(r.status, 200);
    assert.equal(presses.length, 1);
  });
});

// ── The log ───────────────────────────────────────────────────────────────────

describe("the activity log", () => {
  test("a fired cue records the caller's token label", async () => {
    await withCue();
    await call("projectors_on");
    const entry = automationLog.list()[0]!;
    assert.equal(entry.caller, "Home Assistant");
    assert.match(entry.detail, /dispatched p17 r2 c6 "Projectors ON"/);
  });

  test("a BLOCKED cue is logged too, with the caller and the reason", async () => {
    await withCue();
    setLive("Sunday Morning");
    await call("projectors_on");
    const entry = automationLog.list()[0]!;
    assert.equal(entry.caller, "Home Assistant");
    assert.equal(entry.outcome, "condition-not-met");
    assert.match(entry.detail, /Sunday Morning is live/);
  });
});

// ── The trigger cannot fire itself ────────────────────────────────────────────

describe("a called cue never fires from an event", () => {
  test("didFire is false for every snapshot pair", async () => {
    const trigger = AUTOMATION_TRIGGERS[CALL_TRIGGER_ID]!;
    const snaps: unknown[] = [null, {}, { mode: "item" }, [{ id: "companion", connection: "connected" }], "x", 0];
    for (const prev of snaps) {
      for (const next of snaps) {
        assert.equal(
          trigger.didFire(prev, next, { name: "projectors_on" }, Date.now()),
          false,
          `didFire fired on ${JSON.stringify(prev)} -> ${JSON.stringify(next)}`,
        );
      }
    }
  });

  test("THE ENGINE refuses it even when didFire says yes", async () => {
    // didFire is the trigger author's discipline; this is the engine's. The
    // override is what makes this a test of the ENGINE rather than a second copy
    // of the one above — remove the CALL_CHANNEL skip in handleBroadcast and
    // this goes red while everything else stays green.
    await withCue();
    const trigger = AUTOMATION_TRIGGERS[CALL_TRIGGER_ID]!;
    const real = trigger.didFire;
    trigger.didFire = () => true;
    try {
      // Two broadcasts: the first seeds the channel, the second is the "edge".
      await automationEngine.__handleBroadcast("cue:call", { a: 1 }, Date.now());
      await automationEngine.__handleBroadcast("cue:call", { a: 2 }, Date.now() + 1000);
    } finally {
      trigger.didFire = real;
    }
    assert.equal(presses.length, 0, "a cue fired itself off the bus");
    assert.equal(automationLog.list().length, 0, "the engine evaluated a call-only rule");
  });
});

// ── Names are unique ──────────────────────────────────────────────────────────

describe("cue names", () => {
  test("a duplicate name is refused with 400", async () => {
    await withCue();
    const r = await callRoute(automationRoutes, "/api/automation/rules", {
      method: "POST",
      body: {
        name: "Another one",
        enabled: true,
        trigger: { id: CALL_TRIGGER_ID, params: { name: "projectors_on" } },
        conditions: [],
        action: { id: "log.message", params: { message: "x" } },
        cooldownSec: 0,
        oncePerService: false,
      },
    });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /already used/);
    assert.equal(automationEngine.cueRules().length, 1);
  });

  test("a name that is not snake_case is refused", async () => {
    await withCue();
    const r = await callRoute(automationRoutes, "/api/automation/rules", {
      method: "POST",
      body: {
        name: "Shouty",
        enabled: true,
        trigger: { id: CALL_TRIGGER_ID, params: { name: "Projectors ON!" } },
        conditions: [],
        action: { id: "log.message", params: { message: "x" } },
        cooldownSec: 0,
        oncePerService: false,
      },
    });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /lower_snake_case/);
  });
});

describe("a pair's state binding", () => {
  /** One rule POST, with whatever trigger params the case needs. */
  const post = (params: Record<string, string>) =>
    callRoute(automationRoutes, "/api/automation/rules", {
      method: "POST",
      body: {
        name: "Projectors ON",
        enabled: true,
        trigger: { id: CALL_TRIGGER_ID, params },
        conditions: [],
        action: { id: "log.message", params: { message: "x" } },
        cooldownSec: 0,
        oncePerService: false,
      },
    });

  test("a variable name Companion could not have is refused with 400", async () => {
    // Accepted, it is a switch that reads unknown forever with nothing saying
    // which rule is wrong — the state route would answer 404 for it every poll.
    await withCue();
    const r = await post({ name: "screens_on", stateVariable: "state:projectors" });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /not a Companion variable name/);
    assert.equal(automationEngine.cueRules().length, 1, "the rule was saved anyway");
  });

  test("on and off values that are the same string are refused with 400", async () => {
    await withCue();
    const r = await post({
      name: "screens_on",
      stateVariable: "screens_state",
      stateOnValue: "1",
      stateOffValue: "1",
    });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /could never be read/);
  });

  test("a good binding saves, and comes back on the rule", async () => {
    await withCue();
    const r = await post({ name: "screens_on", stateVariable: "screens_state" });
    assert.equal(r.status, 201);
    const saved = automationEngine.cueRules().find((x) => x.trigger.params.name === "screens_on");
    assert.equal(String(saved?.trigger.params.stateVariable), "screens_state");
  });
});

describe("GET /api/cues/states", () => {
  /** A bound pair on the real engine, through the real addRule. */
  async function withBoundPair(params: Record<string, string> = {}): Promise<void> {
    for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
    for (const [name, extra] of [
      ["projectors_on", { stateVariable: "projectors_state", ...params }],
      ["projectors_off", {}],
    ] as const) {
      await automationEngine.addRule({
        name,
        enabled: true,
        trigger: { id: CALL_TRIGGER_ID, params: { name, ...extra } },
        conditions: [],
        action: { id: "companion.press", params: { page: 1, row: 0, col: 1 } },
        cooldownSec: 0,
        oncePerService: false,
      });
    }
  }

  const states = async (): Promise<Record<string, Record<string, unknown>>> => {
    const r = await callRoute(cueRoutes, "/api/cues/states");
    assert.equal(r.status, 200);
    return (r.json as { states: Record<string, Record<string, unknown>> }).states;
  };

  test("is an OPEN read — no token, like the YAML and the token list", async () => {
    // The thing polling it is a Home Assistant `rest` sensor, which carries no
    // token, and a same-origin GET sends no Origin to gate on.
    await withBoundPair();
    variables.projectors_state = "on";
    const r = await callRoute(cueRoutes, "/api/cues/states");
    assert.equal(r.status, 200);
  });

  test("answers on for the on value and off for the off value", async () => {
    await withBoundPair();
    variables.projectors_state = "on";
    assert.equal(String((await states()).projectors!.state), "on");

    cueStates.invalidate();
    variables.projectors_state = "off";
    assert.equal(String((await states()).projectors!.state), "off");
  });

  test("a variable Companion does not have is unknown, with the reason", async () => {
    await withBoundPair();
    const row = (await states()).projectors!;
    assert.equal(String(row.state), "unknown");
    assert.equal(String(row.reason), "no such custom variable in Companion");
    assert.equal(row.value, null);
  });

  test("a value that is neither says what it read", async () => {
    await withBoundPair();
    variables.projectors_state = "WARMUP";
    const row = (await states()).projectors!;
    assert.equal(String(row.state), "unknown");
    assert.equal(String(row.reason), 'value "WARMUP" matches neither "on" nor "off"');
  });

  test("an unbound pair is not in the answer at all", async () => {
    await withCue();
    assert.deepEqual(Object.keys(await states()), []);
    assert.deepEqual(variableReads, [], "an unbound pair must not read anything");
  });

  test("a binding saved inside the window is read back through the NEW variable", async () => {
    // The cache is five seconds and nothing dropped it when a rule changed, so
    // the operator saved a binding, the row refreshed, and it still reported the
    // old variable — for up to five seconds, contradicting what they had just
    // typed. No injected clock here on purpose: this is the real engine, the
    // real route and the real cache, inside the real window.
    await withBoundPair();
    variables.projectors_state = "on";
    variables.amps_state = "off";
    assert.equal(String((await states()).projectors!.variable), "projectors_state");

    const on = automationEngine.listRules().find((r) => r.trigger.params.name === "projectors_on")!;
    await automationEngine.updateRule(on.id, {
      trigger: { id: CALL_TRIGGER_ID, params: { ...on.trigger.params, stateVariable: "amps_state" } },
    });

    const row = (await states()).projectors!;
    assert.equal(String(row.variable), "amps_state", "the states answer is five seconds stale after a save");
    assert.equal(String(row.state), "off");
  });

  test("a read that REJECTS is still a 200, with that pair unknown", async () => {
    // getTarget reaches the config store, and its rejection escaped
    // readCustomVariable — which under a batch read of every bound pair was a
    // 500 here, taking out the Home Assistant sensor that covers all of them
    // for one unreadable file.
    await withBoundPair();
    const real = companionDeps.getTarget;
    companionDeps.getTarget = async () => {
      throw new Error("secrets.bin is unreadable");
    };
    try {
      const r = await callRoute(cueRoutes, "/api/cues/states");
      assert.equal(r.status, 200);
      const row = (r.json as { states: Record<string, Record<string, unknown>> }).states.projectors!;
      assert.equal(String(row.state), "unknown");
      assert.equal(String(row.reason), "secrets.bin is unreadable");
    } finally {
      companionDeps.getTarget = real;
    }
  });

  test("the answer is cached, so a second poll does not read Companion again", async () => {
    await withBoundPair();
    variables.projectors_state = "on";
    await states();
    assert.deepEqual(variableReads, ["projectors_state"]);
    await states();
    assert.deepEqual(variableReads, ["projectors_state"], "the second poll went to Companion");
  });
});

describe("a cue's former names", () => {
  /** The cue, renamed, still carrying the name Home Assistant was pasted with. */
  const renamed = () =>
    withCue({
      name: "Screens ON",
      trigger: {
        id: CALL_TRIGGER_ID,
        params: { name: "screens_on", says: "the screens", aliases: "projectors_on" },
      },
    });

  test("a call through a former name presses the button", async () => {
    // The whole point of keeping the old name: the HomeKit switch was created
    // from `rest_command.su_projectors_on` and nobody has re-pasted the YAML.
    await renamed();
    const r = await call("projectors_on");
    assert.equal(r.status, 200);
    assert.deepEqual(presses, ["http://10.0.0.5:8000/api/location/17/2/6/press"]);
  });

  test("and the log line says BOTH names, with an arrow", async () => {
    // Otherwise the only trace of a Home Assistant still holding a stale name is
    // a line naming a cue that is not in the rules list under that name.
    await renamed();
    const lines: string[] = [];
    const real = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      await call("projectors_on");
    } finally {
      console.log = real;
    }
    assert.ok(
      lines.includes("[cues] projectors_on → screens_on by Home Assistant: dispatched"),
      `no arrow line was logged; got:\n  ${lines.join("\n  ")}`,
    );
  });

  test("a call by the CURRENT name logs one name, not an arrow to itself", async () => {
    await renamed();
    const lines: string[] = [];
    const real = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      await call("screens_on");
    } finally {
      console.log = real;
    }
    assert.ok(
      lines.includes("[cues] screens_on by Home Assistant: dispatched"),
      `the plain line is gone; got:\n  ${lines.join("\n  ")}`,
    );
  });

  test("a name that is nobody's, current or former, is still 404", async () => {
    await renamed();
    const r = await call("lobby_tvs_on");
    assert.equal(r.status, 404);
    assert.deepEqual(presses, []);
  });
});

// ── /api/action/invoke ────────────────────────────────────────────────────────

describe("the token gate on /api/action/invoke", () => {
  const invoke = (headers: Record<string, string>) =>
    callRoute(automationRoutes, "/api/action/invoke", {
      method: "POST",
      headers,
      body: { actionId: "log.message", params: { message: "hello" } },
    });

  test("no Origin and no token is 401", async () => {
    const r = await invoke({});
    assert.equal(r.status, 401);
  });

  test("no Origin WITH a token runs", async () => {
    const r = await invoke(auth());
    assert.equal(r.status, 200);
    assert.equal((r.json as { ok: boolean }).ok, true);
  });

  test("a same-origin browser still works, exactly as before", async () => {
    // remote-server has already refused a cross-origin write by the time a
    // request with an Origin reaches this handler, so an Origin here is ours.
    const r = await invoke(browser);
    assert.equal(r.status, 200);
    assert.equal((r.json as { ok: boolean }).ok, true);
  });
});

// ── Tokens ────────────────────────────────────────────────────────────────────

describe("token management", () => {
  test("mint returns the secret once, and the list never carries a hash", async () => {
    const minted = await callRoute(cueRoutes, "/api/cues/tokens", {
      method: "POST",
      headers: browser,
      body: { label: "Kitchen tablet" },
    });
    assert.equal(minted.status, 201);
    const secret = (minted.json as { secret: string }).secret;
    assert.match(secret, /^su_/);

    const listed = await callRoute(cueRoutes, "/api/cues/tokens", { headers: browser });
    const tokens = (listed.json as { tokens: Record<string, unknown>[] }).tokens;
    assert.ok(tokens.some((t) => t.label === "Kitchen tablet"));
    for (const t of tokens) {
      assert.equal("hash" in t, false, "a hash reached a client");
      assert.equal(String(JSON.stringify(t)).includes("su_"), false);
    }

    // The minted token works, and revoking it stops it.
    const id = tokens.find((t) => t.label === "Kitchen tablet")!.id as string;
    await withCue();
    assert.equal((await call("projectors_on", { headers: { authorization: `Bearer ${secret}` } })).status, 200);

    const revoked = await callRoute(cueRoutes, `/api/cues/tokens/${id}`, {
      method: "DELETE",
      headers: browser,
    });
    assert.equal(revoked.status, 200);
    await withCue();
    assert.equal((await call("projectors_on", { headers: { authorization: `Bearer ${secret}` } })).status, 401);
  });

  test("LISTING is an open read, and carries nothing secret", async () => {
    // Deliberately ungated, like every other read in this app. A same-origin GET
    // sends no Origin, so the only thing it could be gated on is a header curl
    // can type — and the list is labels, ids and timestamps. The hashes never
    // leave cue-tokens.ts.
    const r = await callRoute(cueRoutes, "/api/cues/tokens");
    assert.equal(r.status, 200);
    const tokens = (r.json as { tokens: Record<string, unknown>[] }).tokens;
    assert.ok(tokens.length > 0);
    for (const t of tokens) {
      assert.equal("hash" in t, false, "a hash reached a client");
      assert.equal(JSON.stringify(t).includes("su_"), false);
    }
  });

  test("a call records lastUsedAt", async () => {
    await withCue();
    await call("projectors_on");
    const listed = await callRoute(cueRoutes, "/api/cues/tokens", { headers: browser });
    const ha = (listed.json as { tokens: { label: string; lastUsedAt: string | null }[] }).tokens.find(
      (t) => t.label === "Home Assistant",
    )!;
    assert.ok(ha.lastUsedAt, "the token's last use was recorded");
  });
});

// ── Companion pickers ─────────────────────────────────────────────────────────

describe("the button and pair endpoints", () => {
  test("buttons come back grouped-ready, from the export", async () => {
    const r = await callRoute(cueRoutes, "/api/companion/buttons");
    assert.equal(r.status, 200);
    const body = r.json as { ok: boolean; buttons: { pageName: string; label: string }[] };
    assert.equal(body.ok, true);
    assert.equal(body.buttons.length, 14);
    assert.ok(body.buttons.some((b) => b.pageName === FIXTURE_PAGES.screens));
  });

  test("every button carries its page id and its action ids, so the picker can fingerprint it", async () => {
    // Without these on the wire the picker would have to make a second request
    // per button, and a rule created from it would be pinned to coordinates
    // alone — which is the whole bug the fingerprint exists to remove.
    const r = await callRoute(cueRoutes, "/api/companion/buttons");
    const buttons = (r.json as { buttons: CompanionButton[] }).buttons;
    const on = buttons.find((b) => b.page === 1 && b.row === 0 && b.col === 1)!;
    assert.equal(on.pageId, FIXTURE_PAGE_IDS[1]);
    assert.deepEqual(on.actionIds, [fixtureActionId(1, 0, 1, 0)]);
    assert.equal(
      buttons.every((b) => typeof b.pageId === "string" && Array.isArray(b.actionIds)),
      true,
      "a button came back without the fingerprint fields",
    );
  });

  test("an unreachable Companion answers 200 with the reason, so the picker can offer the fields", async () => {
    const real = companionDeps.fetch;
    companionDeps.fetch = async () => {
      throw new Error("EHOSTUNREACH");
    };
    companionApi.invalidate();
    try {
      const r = await callRoute(cueRoutes, "/api/companion/buttons");
      assert.equal(r.status, 200);
      const body = r.json as { ok: boolean; reason: string; buttons: unknown[] };
      assert.equal(body.ok, false);
      assert.match(body.reason, /EHOSTUNREACH/);
      assert.deepEqual(body.buttons, []);
    } finally {
      companionDeps.fetch = real;
      companionApi.invalidate();
    }
  });

  test("pairs carry a slug and whether the rule already exists", async () => {
    for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
    const r = await callRoute(cueRoutes, "/api/companion/pairs");
    const pairs = (r.json as { pairs: { base: string; slug: string; exists: boolean }[] }).pairs;
    assert.equal(pairs.length, 4);
    assert.deepEqual(
      pairs.map((p) => p.slug),
      // "Projectors" is on both fixture pages, so both are prefixed. See
      // slugsForPairs — a plain slug would have one of them refused on import.
      ["lobby_tvs", "room_a_screens_projectors", "room_a_lighting_projectors", "rig"],
    );
    assert.equal(pairs.every((p) => !p.exists), true);
  });

  test("the offer carries Companion's custom variables, for the state select", async () => {
    // EXACT. The fixture declares five and two of them are names Companion's own
    // value API could never answer for — offering one would bind a cue to a
    // permanent 404, chosen from a dropdown.
    const r = await callRoute(cueRoutes, "/api/companion/pairs");
    assert.deepEqual((r.json as { customVariables: string[] }).customVariables, [
      "house_lights_state",
      "lobby_tvs",
      "rig.state",
    ]);
  });

  test("the ticked-by-default pairs come from what the buttons DRIVE, not a page name", async () => {
    for (const rule of automationEngine.listRules()) await automationEngine.removeRule(rule.id);
    const r = await callRoute(cueRoutes, "/api/companion/pairs");
    const body = r.json as { pairs: { slug: string; suggested: boolean }[]; defaultPages?: unknown };
    assert.deepEqual(
      body.pairs.filter((p) => p.suggested).map((p) => p.slug),
      ["room_a_screens_projectors", "room_a_lighting_projectors", "rig"],
    );
    // "lobby_tvs" drives generic-tcp-udp — something we cannot call a projector —
    // so it is offered unticked rather than pre-armed.
    assert.deepEqual(
      body.pairs.filter((p) => !p.suggested).map((p) => p.slug),
      ["lobby_tvs"],
    );
    assert.equal("defaultPages" in body, false, "a site's page names came back over the wire");
  });
});

describe("importing pairs", () => {
  test("creates two rules per pair, guarded and on a cooldown", async () => {
    for (const rule of automationEngine.listRules()) await automationEngine.removeRule(rule.id);
    const pairs = (
      (await callRoute(cueRoutes, "/api/companion/pairs")).json as {
        pairs: { base: string; slug: string; page: number; on: unknown; off: unknown }[];
      }
    ).pairs.filter((p) => p.page === 1);

    const r = await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
      method: "POST",
      headers: browser,
      body: { pairs },
    });
    assert.equal(r.status, 200);
    const { created, skipped } = r.json as { created: string[]; skipped: unknown[] };
    assert.deepEqual(created, [
      "lobby_tvs_on",
      "lobby_tvs_off",
      "room_a_screens_projectors_on",
      "room_a_screens_projectors_off",
    ]);
    assert.deepEqual(skipped, []);

    const rules = automationEngine.cueRules();
    assert.equal(rules.length, 4);
    for (const rule of rules) {
      assert.deepEqual(rule.conditions, [{ id: "service.is-not-live", params: {} }]);
      assert.equal(rule.cooldownSec, 3);
      assert.equal(rule.enabled, true);
      assert.equal(rule.action.id, "companion.press");
    }

    // And the imported cue actually presses the coordinate it was imported with.
    presses = [];
    const fired = await call("room_a_screens_projectors_on");
    assert.equal(fired.status, 200);
    assert.deepEqual(presses, ["http://10.0.0.5:8000/api/location/1/0/1/press"]);
  });

  test("re-importing skips what exists and says which, rather than overwriting", async () => {
    const pairs = (
      (await callRoute(cueRoutes, "/api/companion/pairs")).json as { pairs: { page: number }[] }
    ).pairs.filter((p) => p.page === 1);

    const r = await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
      method: "POST",
      headers: browser,
      body: { pairs },
    });
    const { created, skipped } = r.json as { created: string[]; skipped: { name: string }[] };
    assert.deepEqual(created, []);
    assert.deepEqual(
      skipped.map((s) => s.name),
      [
        "lobby_tvs_on",
        "lobby_tvs_off",
        "room_a_screens_projectors_on",
        "room_a_screens_projectors_off",
      ],
    );
    assert.equal(automationEngine.cueRules().length, 4, "nothing was duplicated");
  });
});

// ── Home Assistant ────────────────────────────────────────────────────────────

describe("the Home Assistant config", () => {
  test("one rest_command per cue and one switch per pair", async () => {
    const r = await callRoute(cueRoutes, "/api/cues/home-assistant.yaml", { headers: browser });
    assert.equal(r.status, 200);
    assert.match(r.headers["Content-Type"] ?? "", /yaml/);
    // The download button relies on this exact filename — the docs tell the
    // operator to save it as packages/stage_utility.yaml.
    assert.equal(r.headers["Content-Disposition"], 'attachment; filename="stage_utility.yaml"');
    const yaml = r.body;

    // Four cues from the import above -> four commands, two pairs -> two switches.
    assert.equal((yaml.match(/^ {2}su_\w+:$/gm) ?? []).length, 4);
    assert.equal((yaml.match(/^ {8}optimistic: true$/gm) ?? []).length, 2);
    assert.match(yaml, /url: "http:\/\/[^"]+\/api\/cues\/room_a_screens_projectors_on"/);
    assert.match(yaml, /authorization: !secret stage_utility_token/);
    // The switch is the THING; Home Assistant supplies the verb.
    // Both fixture pages have a "Projectors" pair, so the switch has to name
    // the page too — otherwise Home Assistant gets two switches called
    // "Projectors" and the operator picks one at random.
    assert.match(yaml, /^ {6}- name: "Room A: Screens Projectors"$/m);
    assert.match(yaml, /^ {6}- name: "Lobby: TVs"$/m);
    // Under the template integration's own key, once. The legacy
    // `switch: - platform: template` spelling this used to serve is refused by
    // current Home Assistant, so every switch in a pasted fragment vanished.
    assert.equal((yaml.match(/^template:$/gm) ?? []).length, 1);
    assert.equal(/^switch:$/m.test(yaml), false, "the legacy switch: block is back");
  });

  test("it is an open read, and never contains a token", async () => {
    // Ungated for the same reason the token list is: a same-origin GET sends no
    // Origin. It names cues that GET /api/automation/rules already serves to
    // anyone on the LAN, and refers to the token as `!secret`.
    const r = await callRoute(cueRoutes, "/api/cues/home-assistant.yaml");
    assert.equal(r.status, 200);
    assert.equal(r.body.includes("su_"), true, "the cue names are there");
    assert.equal(/Bearer\s+su_[A-Za-z0-9_-]{20,}/.test(r.body), false, "a real token is in the YAML");
    assert.match(r.body, /authorization: !secret stage_utility_token/);
  });
});

// LAST in the file on purpose. The Home Assistant cases above read whatever the
// pair import left in the rule store, and a block that wipes it has to come
// after them or their four rest_commands become three.
describe("importing single buttons", () => {
  /** The `buttons` half of the import offer, from the real route. */
  async function offered(): Promise<Record<string, unknown>[]> {
    return (
      (await callRoute(cueRoutes, "/api/companion/pairs")).json as {
        buttons: Record<string, unknown>[];
      }
    ).buttons;
  }

  test("the offer is every LABELLED button that is not half of a pair, ticked by nothing", async () => {
    for (const rule of automationEngine.listRules()) await automationEngine.removeRule(rule.id);
    const buttons = await offered();
    // Page 1: House Lights ON (an ON with no OFF), Take Screens. The unlabelled
    // button at r3c0 is left out — a cue called nothing cannot be called.
    // Page 3: Cam 1 and Record Toggle on row 0, then Cam 2 on row 1 — Cam 1 and
    // Cam 2 both run nothing, which is what the reconcile's "an empty
    // fingerprint is never searched for" guard needs. See the fixture.
    assert.deepEqual(
      buttons.map((b) => `${b.page as number}:${b.slug as string}`),
      ["1:house_lights_on", "1:take_screens", "3:cam_1", "3:record_toggle", "3:cam_2"],
    );
    assert.equal(
      buttons.some((b) => "suggested" in b),
      false,
      "a single button must not arrive pre-ticked — that is a cue somebody can say by accident",
    );
    assert.equal(buttons.every((b) => b.exists === false), true);
  });

  test("each becomes ONE cue, guarded and on a cooldown, and presses its coordinates", async () => {
    for (const rule of automationEngine.listRules()) await automationEngine.removeRule(rule.id);
    const buttons = (await offered()).filter((b) => b.slug === "take_screens" || b.slug === "cam_1");

    const r = await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
      method: "POST",
      headers: browser,
      body: { buttons },
    });
    assert.equal(r.status, 200);
    const { created, skipped } = r.json as { created: string[]; skipped: unknown[] };
    assert.deepEqual(created, ["take_screens", "cam_1"]);
    assert.deepEqual(skipped, []);

    const rules = automationEngine.cueRules();
    assert.equal(rules.length, 2, "one rule per button, not two");
    for (const rule of rules) {
      assert.deepEqual(rule.conditions, [{ id: "service.is-not-live", params: {} }]);
      assert.equal(rule.cooldownSec, 3);
      assert.equal(rule.action.id, "companion.press");
    }
    const take = rules.find((x) => automationEngine.cueNameOf(x) === "take_screens")!;
    assert.equal(take.trigger.params.says, "Take Screens");
    assert.equal(take.name, "Take Screens");

    presses = [];
    assert.equal((await call("take_screens")).status, 200);
    assert.deepEqual(presses, ["http://10.0.0.5:8000/api/location/1/2/3/press"]);
  });

  test("re-importing skips what exists and says which", async () => {
    const buttons = (await offered()).filter((b) => b.slug === "take_screens");
    const r = await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
      method: "POST",
      headers: browser,
      body: { buttons },
    });
    const { created, skipped } = r.json as { created: string[]; skipped: { name: string }[] };
    assert.deepEqual(created, []);
    assert.deepEqual(
      skipped.map((x) => x.name),
      ["take_screens"],
    );
    assert.equal(automationEngine.cueRules().length, 2, "nothing was duplicated");
  });

  test("the offer marks what already exists, so the dialog can disable it", async () => {
    const buttons = await offered();
    assert.deepEqual(
      buttons.filter((b) => b.exists).map((b) => b.slug),
      ["take_screens", "cam_1"],
    );
  });

  test("and marks a FORMER name as taken too, because the engine refuses it", async () => {
    // The ordinary case after a relabel: a button renamed "Screens" and then
    // back to "Take Screens" is offered as `take_screens`, which is now the
    // cue's former name. The engine treats names and former names as one
    // namespace, so an offer shown as available would be ticked and then
    // refused by addRule with the operator having been told it was free.
    const take = automationEngine
      .cueRules()
      .find((x) => automationEngine.cueNameOf(x) === "take_screens")!;
    await automationEngine.updateRule(take.id, {
      trigger: {
        ...take.trigger,
        params: { ...take.trigger.params, name: "screens", aliases: "take_screens" },
      },
    });
    try {
      const offer = (await offered()).find((b) => b.slug === "take_screens")!;
      assert.equal(
        offer.exists,
        true,
        "a button whose cue name is somebody's former name was offered as available",
      );
    } finally {
      await automationEngine.updateRule(take.id, {
        trigger: { ...take.trigger, params: { ...take.trigger.params, name: "take_screens", aliases: "" } },
      });
    }
  });

  test("two pages with the same label are named after their page, on both", async () => {
    // The pairs import has always done this; a single button collides in exactly
    // the same way, and without it the second import is refused as a duplicate
    // and one room quietly has no cue.
    for (const rule of automationEngine.listRules()) await automationEngine.removeRule(rule.id);
    const real = companionDeps.fetch;
    companionDeps.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/press")) {
        presses.push(url);
        return new Response("ok", { status: 200 });
      }
      // "Take Screens" now exists on page 2 as well, driving something else.
      const doc = companionExportFixture() as {
        pages: Record<string, { controls: Record<string, Record<string, unknown>> }>;
      };
      const source = doc.pages["1"]!.controls["2"]!["3"];
      doc.pages["2"]!.controls["3"] = { "3": source };
      return Response.json(doc);
    };
    companionApi.invalidate();
    try {
      const buttons = (await offered()).filter((b) => slugOf(b).endsWith("take_screens"));
      assert.deepEqual(
        buttons.map((b) => b.slug),
        ["room_a_screens_take_screens", "room_a_lighting_take_screens"],
      );
      const r = await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
        method: "POST",
        headers: browser,
        body: { buttons },
      });
      assert.deepEqual((r.json as { created: string[] }).created, [
        "room_a_screens_take_screens",
        "room_a_lighting_take_screens",
      ]);
      // And the WORDS are disambiguated too, or Home Assistant gets two scripts
      // with one alias between them.
      assert.deepEqual(
        automationEngine.cueRules().map((x) => String(x.trigger.params.says)),
        ["Room A: Screens Take Screens", "Room A: Lighting Take Screens"],
      );
    } finally {
      companionDeps.fetch = real;
      companionApi.invalidate();
    }
  });

  test("pairs and single buttons import together, in one answer", async () => {
    for (const rule of automationEngine.listRules()) await automationEngine.removeRule(rule.id);
    const offer = (await callRoute(cueRoutes, "/api/companion/pairs")).json as {
      pairs: { slug: string }[];
      buttons: Record<string, unknown>[];
    };
    const r = await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
      method: "POST",
      headers: browser,
      body: {
        pairs: offer.pairs.filter((p) => p.slug === "rig"),
        buttons: offer.buttons.filter((b) => b.slug === "cam_1"),
      },
    });
    assert.deepEqual((r.json as { created: string[] }).created, ["rig_on", "rig_off", "cam_1"]);
  });

  test("a body with neither key is refused, and one with only pairs still works", async () => {
    const neither = await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
      method: "POST",
      headers: browser,
      body: {},
    });
    assert.equal(neither.status, 400);
    const onlyPairs = await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
      method: "POST",
      headers: browser,
      body: { pairs: [] },
    });
    assert.equal(onlyPairs.status, 200);
    assert.deepEqual(onlyPairs.json, { created: [], skipped: [] });
  });
});

// ── A cue whose button moved ──────────────────────────────────────────────────

describe("reconciling a cue's Companion button", () => {
  /** The whole export, mutated by a case, served to the stub. */
  let exportDoc: Record<string, unknown> = companionExportFixture();
  let exportOk = true;

  /** Every rule's press params, keyed by cue name. */
  const paramsOf = (name: string) =>
    automationEngine.cueRules().find((r) => automationEngine.cueNameOf(r) === name)!.action.params;

  type Doc = {
    pages: Record<string, { controls: Record<string, Record<string, unknown>> }>;
  };

  /** Import the page-1 pair, then reconcile against whatever the case set up. */
  async function importPageOne(): Promise<void> {
    for (const rule of automationEngine.listRules()) await automationEngine.removeRule(rule.id);
    exportDoc = companionExportFixture();
    exportOk = true;
    companionApi.invalidate();
    const pairs = (
      (await callRoute(cueRoutes, "/api/companion/pairs")).json as { pairs: { page: number }[] }
    ).pairs.filter((p) => p.page === 1);
    await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
      method: "POST",
      headers: browser,
      body: { pairs },
    });
  }

  before(() => {
    companionDeps.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/press")) {
        presses.push(url);
        return new Response("ok", { status: 200 });
      }
      if (!exportOk) throw new Error("EHOSTUNREACH");
      return Response.json(exportDoc);
    };
  });

  test("an import records the fingerprint straight away, without waiting for a pass", async () => {
    await importPageOne();
    const f = readFingerprint(paramsOf("room_a_screens_projectors_on"));
    assert.equal(f.status, "in-place");
    assert.equal(f.pageId, FIXTURE_PAGE_IDS[1]);
    assert.deepEqual(f.actionIds, [fixtureActionId(1, 0, 1, 0)]);
  });

  test("buttons/refresh follows a moved button, and the cue presses the NEW coordinates", async () => {
    await importPageOne();
    const d = exportDoc as unknown as Doc;
    const control = d.pages["1"]!.controls["0"]!["1"];
    delete d.pages["1"]!.controls["0"]!["1"];
    d.pages["1"]!.controls["4"] = { "6": control };

    const r = await callRoute(cueRoutes, "/api/companion/buttons/refresh", {
      method: "POST",
      headers: browser,
    });
    assert.equal(r.status, 200);
    const f = readFingerprint(paramsOf("room_a_screens_projectors_on"));
    assert.equal(f.status, "moved");
    assert.deepEqual([f.page, f.row, f.col], [1, 4, 6]);

    presses = [];
    assert.equal((await call("room_a_screens_projectors_on")).status, 200);
    assert.deepEqual(presses, ["http://10.0.0.5:8000/api/location/1/4/6/press"]);
  });

  test("a deleted button answers 409 button-missing and presses NOTHING", async () => {
    await importPageOne();
    const d = exportDoc as unknown as Doc;
    delete d.pages["1"]!.controls["0"]!["1"];
    await callRoute(cueRoutes, "/api/companion/buttons/refresh", { method: "POST", headers: browser });
    assert.equal(readFingerprint(paramsOf("room_a_screens_projectors_on")).status, "missing");

    presses = [];
    const r = await call("room_a_screens_projectors_on");
    assert.equal(r.status, 409);
    const body = r.json as { error: string; reason: string };
    assert.equal(body.reason, "button-missing");
    assert.equal(body.error, "Projectors ON is no longer on Companion page 1");
    assert.deepEqual(presses, [], "a cue whose button is gone must not press a coordinate");
  });

  test("and the engine refuses it from any other path too — the test-fire button", async () => {
    // The 409 lives in the call route's engine path. A rule can also fire from a
    // trigger and from the editor's Test, and a guard on one path is a guard the
    // other two walk around.
    await importPageOne();
    const d = exportDoc as unknown as Doc;
    delete d.pages["1"]!.controls["0"]!["1"];
    await callRoute(cueRoutes, "/api/companion/buttons/refresh", { method: "POST", headers: browser });

    presses = [];
    const rule = automationEngine
      .cueRules()
      .find((x) => automationEngine.cueNameOf(x) === "room_a_screens_projectors_on")!;
    const fired = await automationEngine.testFire(rule.id);
    assert.equal(fired.ok, false);
    assert.match(fired.detail, /no longer on Companion page 1/);
    assert.deepEqual(presses, []);
  });

  /** Rewrite the text layer of the control at these coordinates. */
  function relabel(row: string, col: string, text: string): void {
    const control = (exportDoc as unknown as Doc).pages["1"]!.controls[row]![col] as {
      style: { layers: { type: string; text?: { value: string } }[] };
    };
    const layers = control.style.layers;
    layers[layers.length - 1]!.text = { value: text };
  }

  test("A RELABELLED button renames the cue, and the old name still answers", async () => {
    // The whole path, not the pure pass: the rename has to survive the engine's
    // own name check on save, and the former name has to resolve afterwards.
    // Both were green in isolation while the save threw, on an earlier attempt.
    await importPageOne();
    relabel("0", "1", "Screens ON");
    relabel("0", "2", "Screens OFF");

    const r = await callRoute(cueRoutes, "/api/companion/buttons/refresh", {
      method: "POST",
      headers: browser,
    });
    assert.equal(r.status, 200);

    const names = automationEngine.cueRules().map((x) => automationEngine.cueNameOf(x));
    assert.ok(names.includes("screens_on"), `not renamed; cues are ${names.join(", ")}`);
    assert.ok(names.includes("screens_off"), `the OFF half did not follow; cues are ${names.join(", ")}`);
    const renamed = automationEngine.cueRules().find((x) => automationEngine.cueNameOf(x) === "screens_on")!;
    assert.deepEqual(automationEngine.cueAliasesOf(renamed), ["room_a_screens_projectors_on"]);
    // `says` is NOT touched: a pair's spoken words are "Room A: Screens
    // Projectors on", which the import composed and an operator may have
    // edited — never the button's label, so there is nothing here to follow.
    assert.equal(String(renamed.trigger.params.says), "Room A: Screens Projectors on");

    // The old URL — the one in the pasted Home Assistant config — still fires it.
    presses = [];
    assert.equal((await call("room_a_screens_projectors_on")).status, 200);
    // And the new name fires the other half. A different cue, because an
    // imported cue carries a three-second cooldown.
    assert.equal((await call("screens_off")).status, 200);
    assert.deepEqual(presses, [
      "http://10.0.0.5:8000/api/location/1/0/1/press",
      "http://10.0.0.5:8000/api/location/1/0/2/press",
    ]);
  });

  test("a hand-named cue keeps its name when its button is relabelled", async () => {
    await importPageOne();
    const rule = automationEngine
      .cueRules()
      .find((x) => automationEngine.cueNameOf(x) === "room_a_screens_projectors_on")!;
    await automationEngine.updateRule(rule.id, {
      trigger: { ...rule.trigger, params: { ...rule.trigger.params, name: "big_screens_please" } },
    });
    relabel("0", "1", "Screens ON");

    await callRoute(cueRoutes, "/api/companion/buttons/refresh", { method: "POST", headers: browser });
    const names = automationEngine.cueRules().map((x) => automationEngine.cueNameOf(x));
    assert.ok(names.includes("big_screens_please"), `a typed name was overwritten: ${names.join(", ")}`);
    // The label is still refreshed on the action — that is not the name.
    assert.equal(readFingerprint(paramsOf("big_screens_please")).label, "Screens ON");
  });

  test("a status that could not be SAVED comes back in the answer, not as ok:true", async () => {
    // The catch used to log and carry on, and the route answered ok:true — so a
    // read-only rules file read as a successful refresh, with the pills on the
    // rows still showing what the last good pass found. There was nothing on
    // screen to notice.
    await importPageOne();
    const d = exportDoc as unknown as Doc;
    const control = d.pages["1"]!.controls["0"]!["1"];
    delete d.pages["1"]!.controls["0"]!["1"];
    d.pages["1"]!.controls["4"] = { "6": control };

    const target = automationEngine
      .cueRules()
      .find((x) => automationEngine.cueNameOf(x) === "room_a_screens_projectors_on")!;
    const real = automationEngine.updateRule.bind(automationEngine);
    // ONE rule's save throws. The rest of the pass must still run — abandoning
    // every other cue over one of them is the other half of this being wrong.
    automationEngine.updateRule = async (id, patch) => {
      if (id === target.id) throw new Error("EROFS: read-only file system");
      return real(id, patch);
    };
    try {
      const r = await callRoute(cueRoutes, "/api/companion/buttons/refresh", {
        method: "POST",
        headers: browser,
      });
      assert.equal(r.status, 200);
      const body = r.json as {
        ok: boolean;
        reconcile: { applied: number; failed: { label: string; detail: string }[] };
      };
      assert.equal(body.ok, false, "a refresh that could not save a status answered ok:true");
      assert.equal(body.reconcile.failed.length, 1);
      assert.equal(body.reconcile.failed[0]!.label, "room_a_screens_projectors_on");
      assert.match(body.reconcile.failed[0]!.detail, /read-only file system/);
    } finally {
      automationEngine.updateRule = real;
    }

    // And the status on disk is still the OLD one, which is why the answer has
    // to say so — the cue now presses a coordinate the button has left.
    assert.deepEqual(
      [readFingerprint(paramsOf("room_a_screens_projectors_on")).row, readFingerprint(paramsOf("room_a_screens_projectors_on")).col],
      [0, 1],
    );
  });

  test("the integration row's Test says how many statuses could not be saved", async () => {
    // Test is where an operator looks to find out whether Companion works, and
    // "connected" over a rules file that could not be written is the answer
    // that costs a Sunday. Driven through integrationManager.test, not through
    // a helper: the message is composed at the call site and a test of the
    // wording alone would not notice the count never reaching it.
    await importPageOne();
    const d = exportDoc as unknown as Doc;
    const control = d.pages["1"]!.controls["0"]!["1"];
    delete d.pages["1"]!.controls["0"]!["1"];
    d.pages["1"]!.controls["4"] = { "6": control };

    const target = automationEngine
      .cueRules()
      .find((x) => automationEngine.cueNameOf(x) === "room_a_screens_projectors_on")!;
    const realUpdate = automationEngine.updateRule.bind(automationEngine);
    automationEngine.updateRule = async (id, patch) => {
      if (id === target.id) throw new Error("EROFS: read-only file system");
      return realUpdate(id, patch);
    };
    const restore = withCompanionRow();
    try {
      companionApi.invalidate();
      const r = await integrationManager.test("companion");
      assert.match(r.message ?? "", /1 cue status\(es\) could not be saved\./);
    } finally {
      automationEngine.updateRule = realUpdate;
      restore();
    }
  });

  test("and says nothing of the sort when every status saved", async () => {
    await importPageOne();
    const restore = withCompanionRow();
    try {
      companionApi.invalidate();
      const r = await integrationManager.test("companion");
      assert.equal(/could not be saved/.test(r.message ?? ""), false, r.message);
    } finally {
      restore();
    }
  });

  test("an operator's save DURING the pass survives it", async () => {
    // The pass snapshotted listRules() once and later wrote
    // `{ ...rule.action, params }` from that snapshot, so every other field of
    // the action and the trigger went back as it was when the pass started. An
    // hourly housekeeping sweep reverting an edit the operator had just saved is
    // the worst kind of bug: nothing failed, and the change is simply gone.
    await importPageOne();
    relabel("0", "1", "Screens ON");
    relabel("0", "2", "Screens OFF");
    const halves = automationEngine
      .cueRules()
      .filter((x) => automationEngine.cueNameOf(x).startsWith("room_a_screens_projectors_"))
      .map((x) => x.id);
    assert.equal(halves.length, 2, "the fixture for this case is not a pair");

    const realUpdate = automationEngine.updateRule.bind(automationEngine);
    let edited: string | null = null;
    automationEngine.updateRule = async (id, patch) => {
      const result = await realUpdate(id, patch);
      if (edited === null) {
        // Between the pass's first write and its second: the operator saves the
        // OTHER half with a room typed in. Nothing in the pass touches `room`.
        edited = halves.find((x) => x !== id) ?? null;
        if (edited) {
          const live = automationEngine.listRules().find((r) => r.id === edited)!;
          await realUpdate(edited, {
            trigger: { ...live.trigger, params: { ...live.trigger.params, room: "South Auditorium" } },
          });
        }
      }
      return result;
    };
    try {
      await callRoute(cueRoutes, "/api/companion/buttons/refresh", { method: "POST", headers: browser });
    } finally {
      automationEngine.updateRule = realUpdate;
    }

    assert.ok(edited, "the pass wrote nothing, so nothing was raced");
    const after = automationEngine.listRules().find((r) => r.id === edited)!;
    assert.equal(
      String(after.trigger.params.room),
      "South Auditorium",
      "the reconcile reverted an edit the operator saved while it was running",
    );
    // And the pass still did its own job on that rule.
    assert.match(automationEngine.cueNameOf(after), /^screens_(on|off)$/);
  });

  test("an hourly pass that changed nothing logs no summary line", async () => {
    // 24 lines a day saying "4 in place" on the same /log page an operator
    // reads on a Sunday morning, burying the lines that matter. Every actual
    // decision already logs itself; the summary exists to total those.
    await importPageOne();
    const realLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const first = await runCompanionReconcile();
      assert.equal(first?.applied, 0, "the import left something for the pass to write");
      assert.deepEqual(
        lines.filter((l) => l.includes("reconciled")),
        [],
        "an unchanged pass logged a summary",
      );

      // And a pass that DID change something still says so.
      const d = exportDoc as unknown as Doc;
      const control = d.pages["1"]!.controls["0"]!["1"];
      delete d.pages["1"]!.controls["0"]!["1"];
      d.pages["1"]!.controls["4"] = { "6": control };
      companionApi.invalidate();
      lines.length = 0;
      await runCompanionReconcile();
      assert.equal(
        lines.filter((l) => l.includes("reconciled")).length,
        1,
        `a pass that moved a cue logged no summary; got ${lines.join(" | ")}`,
      );
    } finally {
      console.log = realLog;
    }
  });

  test("a clean refresh says so, with nothing failed", async () => {
    await importPageOne();
    const r = await callRoute(cueRoutes, "/api/companion/buttons/refresh", {
      method: "POST",
      headers: browser,
    });
    const body = r.json as { ok: boolean; reconcile: { failed: unknown[] } };
    assert.equal(body.ok, true);
    assert.deepEqual(body.reconcile.failed, []);
  });

  test("an unreachable Companion changes NO status", async () => {
    // A pass that downgraded every cue to `missing` because a switch was
    // rebooting would refuse every cue in the building until somebody noticed.
    await importPageOne();
    const before = JSON.stringify(paramsOf("room_a_screens_projectors_on"));
    exportOk = false;
    companionApi.invalidate();

    assert.equal(await runCompanionReconcile(), null);
    assert.equal(JSON.stringify(paramsOf("room_a_screens_projectors_on")), before);

    exportOk = true;
    companionApi.invalidate();
  });
});

// ── Importing a state binding ─────────────────────────────────────────────────
//
// LAST IN THE FILE deliberately: both cases wipe the rules, and the import and
// Home Assistant describes above share the four cues the first import creates.
describe("importing a pair with a state variable", () => {
  // The reconcile describe above replaces the Companion stub in its own `before`
  // and never restores it, so the variable read has to be put back.
  before(() => installCompanionStub());

  test("a chosen state variable is written on the _on half only", async () => {
    for (const rule of automationEngine.listRules()) await automationEngine.removeRule(rule.id);
    const pairs = (
      (await callRoute(cueRoutes, "/api/companion/pairs")).json as {
        pairs: { slug: string; on: unknown; off: unknown }[];
      }
    ).pairs
      .filter((p) => p.slug === "lobby_tvs")
      .map((p) => ({ ...p, stateVariable: "lobby_tvs" }));

    const r = await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
      method: "POST",
      headers: browser,
      body: { pairs },
    });
    assert.deepEqual((r.json as { created: string[] }).created, ["lobby_tvs_on", "lobby_tvs_off"]);

    const byName = new Map(
      automationEngine.cueRules().map((x) => [String(x.trigger.params.name), x]),
    );
    assert.equal(String(byName.get("lobby_tvs_on")?.trigger.params.stateVariable), "lobby_tvs");
    // The `_off` half INHERITS it. A copy on both halves is two settings for one
    // pair, and they would drift the first time one was edited.
    assert.equal(byName.get("lobby_tvs_off")?.trigger.params.stateVariable, undefined);

    // And the pair reads its state through it, end to end.
    variables.lobby_tvs = "on";
    cueStates.invalidate();
    const states = (
      (await callRoute(cueRoutes, "/api/cues/states")).json as {
        states: Record<string, { state: string }>;
      }
    ).states;
    assert.equal(states.lobby_tvs?.state, "on");
  });

  test("a state variable Companion could not have skips the pair, creating NEITHER half", async () => {
    // Checked before either half is created: addRule would refuse the `_on` rule
    // and create the `_off` one, leaving half a pair behind for a typo in a
    // field that is not the cue's name.
    for (const rule of automationEngine.listRules()) await automationEngine.removeRule(rule.id);
    const pairs = (
      (await callRoute(cueRoutes, "/api/companion/pairs")).json as { pairs: { slug: string }[] }
    ).pairs
      .filter((p) => p.slug === "lobby_tvs")
      .map((p) => ({ ...p, stateVariable: "state:lobby" }));

    const r = await callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
      method: "POST",
      headers: browser,
      body: { pairs },
    });
    const { created, skipped } = r.json as { created: string[]; skipped: { name: string; why: string }[] };
    assert.deepEqual(created, []);
    assert.deepEqual(
      skipped.map((x) => x.name),
      ["lobby_tvs"],
    );
    assert.match(skipped[0]!.why, /not a Companion variable name/);
    assert.equal(automationEngine.cueRules().length, 0, "half a pair was left behind");
  });
});

// ── A bound cue is idempotent ─────────────────────────────────────────────────

describe("a bound cue does not press when the device is already there", () => {
  // The reconcile describe above replaces the Companion stub in its own `before`
  // and never restores it, so the variable read has to be put back.
  before(() => installCompanionStub());

  /**
   * A pair on the real engine, bound to `projectors_state` unless `bind` is off.
   *
   * BOTH halves press the same coordinates on purpose: this is the toggle
   * button the whole feature exists for — one Companion button, no OFF partner,
   * and only the variable to tell the two directions apart.
   */
  async function withPair(bind = true): Promise<void> {
    for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
    await automationLog.clear();
    for (const [name, extra] of [
      ["projectors_on", bind ? { stateVariable: "projectors_state" } : {}],
      ["projectors_off", {}],
    ] as const) {
      await automationEngine.addRule({
        name,
        enabled: true,
        trigger: { id: CALL_TRIGGER_ID, params: { name, ...extra } },
        conditions: [],
        action: { id: "companion.press", params: { page: 1, row: 0, col: 1 } },
        cooldownSec: 0,
        oncePerService: false,
      });
    }
  }

  /** Put a real cooldown on both halves, as the import does. */
  async function setCooldown(seconds: number): Promise<void> {
    for (const rule of automationEngine.listRules()) {
      await automationEngine.updateRule(rule.id, { cooldownSec: seconds });
    }
  }

  test("_on while the variable says on answers already on and presses nothing", async () => {
    await withPair();
    variables.projectors_state = "on";
    const r = await call("projectors_on");
    assert.equal(r.status, 200);
    const body = r.json as Record<string, unknown>;
    assert.equal(String(body.detail), "already on");
    assert.equal(String(body.state), "on");
    assert.equal(body.skipped, true);
    assert.equal(presses.length, 0, "a cue pressed a toggle button that was already on");
  });

  test("the skip is in the activity log as its own outcome, with the caller", async () => {
    // Not "suppressed": nothing refused this call. An operator reading the log
    // has to be able to tell "Home Assistant asked again and we did nothing"
    // from "a condition stopped it".
    await withPair();
    variables.projectors_state = "on";
    await call("projectors_on");
    const entry = automationLog.list()[0]!;
    assert.equal(entry.outcome, "skipped");
    assert.equal(entry.caller, "Home Assistant");
    assert.match(entry.detail, /already on, not pressed/);
  });

  test("three calls in a row while it is on are three skips and no presses", async () => {
    // The failure this exists for: a toggle button pressed once per repeat left
    // the light in the wrong state, and the log showed the same `_on` cue
    // dispatched seconds apart. The cooldown is zero here so the SKIP is what
    // is being proved, not the cooldown backstop behind it.
    await withPair();
    variables.projectors_state = "on";
    const answers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const body = (await call("projectors_on")).json as Record<string, unknown>;
      answers.push(String(body.detail));
    }
    assert.deepEqual(answers, ["already on", "already on", "already on"]);
    assert.equal(presses.length, 0);
  });

  test("_on while the variable says off presses, and says what it read", async () => {
    await withPair();
    variables.projectors_state = "off";
    const body = (await call("projectors_on")).json as Record<string, unknown>;
    assert.equal(String(body.state), "off");
    assert.equal(body.skipped, undefined);
    assert.equal(presses.length, 1);
  });

  test("_off while the variable says on presses; while it says off it does not", async () => {
    await withPair();
    variables.projectors_state = "on";
    assert.equal(presses.length, 0);
    const pressed = (await call("projectors_off")).json as Record<string, unknown>;
    assert.equal(pressed.skipped, undefined);
    assert.equal(presses.length, 1);

    variables.projectors_state = "off";
    cueStates.invalidate();
    const skipped = (await call("projectors_off")).json as Record<string, unknown>;
    assert.equal(skipped.skipped, true);
    assert.equal(String(skipped.detail), "already off");
    assert.equal(presses.length, 1, "off was pressed again with the device already off");
  });

  test("a repeat inside the COOLDOWN is answered already on, not 409", async () => {
    // The case the whole feature exists for, at the cooldown every imported cue
    // actually carries: Home Assistant repeats `turn_on` about two seconds
    // apart. Below the cooldown check this answered 409 `cooldown` — an error
    // in Home Assistant's log for a call that was correct and needed nothing
    // done — and the skip never ran.
    await withPair();
    await setCooldown(3);
    variables.projectors_state = "off";
    assert.equal((await call("projectors_on")).status, 200);
    assert.equal(presses.length, 1);

    // The device reports itself on, and the repeat lands well inside 3 s.
    variables.projectors_state = "on";
    cueStates.invalidate();
    const repeat = await call("projectors_on");
    assert.equal(repeat.status, 200);
    const body = repeat.json as Record<string, unknown>;
    assert.equal(String(body.detail), "already on");
    assert.equal(body.skipped, true);
    assert.equal(presses.length, 1);
  });

  test("and the cooldown is still the backstop when the state DISAGREES", async () => {
    // The device has not caught up yet — the variable still says off after the
    // first press — so there is nothing to skip and the cooldown is what stops
    // the second press.
    await withPair();
    await setCooldown(3);
    variables.projectors_state = "off";
    assert.equal((await call("projectors_on")).status, 200);
    cueStates.invalidate();
    const repeat = await call("projectors_on");
    assert.equal(repeat.status, 409);
    assert.equal(String((repeat.json as Record<string, unknown>).reason), "cooldown");
    assert.equal(presses.length, 1, "the cooldown let a second press through");
  });

  test("a state that cannot be read PRESSES, and says unknown", async () => {
    // A read must never be able to stop a press: the variable is missing here,
    // which is exactly what an operator sees before they have set it up.
    await withPair();
    const body = (await call("projectors_on")).json as Record<string, unknown>;
    assert.equal(String(body.state), "unknown");
    assert.equal(body.skipped, undefined);
    assert.equal(presses.length, 1);
  });

  test("an UNBOUND pair presses without reading anything at all", async () => {
    // Not merely "it presses" — that would pass with a read that answered
    // unknown. An unbound pair has nothing to read, and a Companion round trip
    // on every call to find that out is a cost with no answer at the end of it.
    await withPair(false);
    const body = (await call("projectors_on")).json as Record<string, unknown>;
    assert.equal(body.state, undefined);
    assert.equal(presses.length, 1);
    assert.deepEqual(variableReads, [], "an unbound cue read a Companion variable");
  });

  test("a press through a bound cue drops the cached state", async () => {
    // The states cache is five seconds. Left in place across a press, a second
    // call three seconds later reads the state from BEFORE the press and presses
    // again — the repeat this check exists to absorb, arriving through the cache
    // instead.
    await withPair();
    variables.projectors_state = "off";
    await call("projectors_on");
    assert.equal(presses.length, 1);
    variables.projectors_state = "on";
    const second = (await call("projectors_on")).json as Record<string, unknown>;
    assert.equal(second.skipped, true, "the state was read from the cache, from before the press");
    assert.equal(presses.length, 1);
  });

  test("a SIMULATED call keeps the cached state — nothing reached the device", async () => {
    // The cache is dropped after a press because the state it holds is from
    // before it. A simulated call pressed nothing, so the cached state is still
    // true, and dropping it buys every bound pair another round of Companion
    // reads for nothing.
    await withPair();
    variables.projectors_state = "off";
    await automationEngine.setSettings({ simulate: true });
    try {
      await call("projectors_on");
      assert.deepEqual(variableReads, ["projectors_state"]);
      await call("projectors_on");
      assert.deepEqual(variableReads, ["projectors_state"], "a simulated call dropped the cache");
      assert.equal(presses.length, 0);
    } finally {
      await automationEngine.setSettings({ simulate: false });
    }
  });

  test("THE ENGINE never reads state for a rule fired from another trigger", async () => {
    // The check belongs to the CALL route, where the caller may repeat itself.
    // A rule the engine fires from a trigger of its own has already decided the
    // press is what it wants, and putting a Companion round trip in front of
    // every triggered press is a Companion outage stopping automation that
    // never needed it. Move the check into runAction and this goes red.
    await withPair();
    variables.projectors_state = "on";
    await automationEngine.addRule({
      name: "Presses the same button on a trigger",
      enabled: true,
      trigger: { id: "pco.service-started", params: {} },
      conditions: [],
      action: { id: "companion.press", params: { page: 1, row: 0, col: 1 } },
      cooldownSec: 0,
      oncePerService: false,
    });
    const at = Date.parse("2026-07-26T10:00:00Z");
    const live = (mode: string) => ({ mode, currentItemTitle: null, serviceTimeId: "st1" });
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), at);
    await automationEngine.__handleBroadcast("pco:live", live("item"), at + 1000);
    assert.equal(presses.length, 1, "the triggered rule did not press");
    assert.deepEqual(variableReads, [], "a triggered press consulted the state variable");
    setQuiet();
  });
});

// ── A toggle button imported as a pair ────────────────────────────────────────

describe("importing a single button as a TOGGLE pair", () => {
  // The reconcile describe above replaces the Companion stub in its own `before`
  // and never restores it.
  before(() => installCompanionStub());

  /** The `buttons` half of the import offer, from the real route. */
  async function offered(slug: string): Promise<Record<string, unknown>> {
    for (const rule of automationEngine.listRules()) await automationEngine.removeRule(rule.id);
    const buttons = (
      (await callRoute(cueRoutes, "/api/companion/pairs")).json as { buttons: Record<string, unknown>[] }
    ).buttons;
    return buttons.find((b) => b.slug === slug)!;
  }

  const importing = (buttons: unknown[]) =>
    callRoute(cueRoutes, "/api/automation/rules/import-pairs", {
      method: "POST",
      headers: browser,
      body: { buttons },
    });

  test("a state variable turns one button into two cues that press the SAME key", async () => {
    // The failure this exists for: "House Lights ON" is really a toggle with no
    // OFF partner. Imported as one cue it became a Home Assistant script, which
    // HomeKit shows as a momentary switch that snaps back, and every tap pressed
    // the toggle again.
    const button = await offered("house_lights_on");
    const r = await importing([{ ...button, stateVariable: "house_lights_state" }]);
    assert.deepEqual((r.json as { created: string[] }).created, ["house_lights_on", "house_lights_off"]);

    const rules = automationEngine.cueRules();
    assert.equal(rules.length, 2);
    const byName = new Map(rules.map((x) => [String(x.trigger.params.name), x]));
    for (const name of ["house_lights_on", "house_lights_off"]) {
      const rule = byName.get(name)!;
      assert.equal(rule.action.id, "companion.press");
      assert.equal(`${rule.action.params.page}:${rule.action.params.row}:${rule.action.params.col}`, "1:2:1");
      assert.deepEqual(rule.conditions, [{ id: "service.is-not-live", params: {} }]);
      assert.equal(rule.cooldownSec, 3);
    }
    // The binding is on the `_on` half only; the `_off` half inherits it.
    assert.equal(String(byName.get("house_lights_on")!.trigger.params.stateVariable), "house_lights_state");
    assert.equal(byName.get("house_lights_off")!.trigger.params.stateVariable, undefined);
    // The direction word comes off the LABEL: "House Lights ON" off is spoken
    // "House Lights off", never "House Lights ON off".
    assert.equal(String(byName.get("house_lights_on")!.trigger.params.says), "House Lights on");
    assert.equal(String(byName.get("house_lights_off")!.trigger.params.says), "House Lights off");
    assert.equal(byName.get("house_lights_off")!.name, "House Lights OFF");

    // And both halves really press that one key, through the real route.
    presses = [];
    variables.house_lights_state = "off";
    assert.equal((await call("house_lights_on")).status, 200);
    variables.house_lights_state = "on";
    cueStates.invalidate();
    assert.equal((await call("house_lights_off")).status, 200);
    assert.deepEqual(presses, [
      "http://10.0.0.5:8000/api/location/1/2/1/press",
      "http://10.0.0.5:8000/api/location/1/2/1/press",
    ]);
  });

  test("a trailing Toggle is stripped too, not just ON and OFF", async () => {
    const button = await offered("record_toggle");
    const r = await importing([{ ...button, stateVariable: "house_lights_state" }]);
    assert.deepEqual((r.json as { created: string[] }).created, ["record_on", "record_off"]);
    const says = automationEngine.cueRules().map((x) => String(x.trigger.params.says));
    assert.deepEqual(says, ["Record on", "Record off"]);
  });

  test("WITHOUT a variable the same button is one cue, exactly as before", async () => {
    const button = await offered("house_lights_on");
    const r = await importing([button]);
    assert.deepEqual((r.json as { created: string[] }).created, ["house_lights_on"]);
    const rules = automationEngine.cueRules();
    assert.equal(rules.length, 1, "a button with no state variable became a pair");
    assert.equal(rules[0]!.trigger.params.stateVariable, undefined);
  });

  test("the resulting pair IS a toggle pair, and the config says so", async () => {
    // The generated YAML is what an operator pastes into Home Assistant, so the
    // shape is proved end to end rather than over the resolver alone.
    const button = await offered("house_lights_on");
    await importing([{ ...button, stateVariable: "house_lights_state" }]);
    const r = await callRoute(cueRoutes, "/api/cues/home-assistant.yaml");
    assert.equal(r.status, 200);
    assert.equal(
      String(r.body).includes(
        "# toggle button: both directions press the same Companion button, so the state variable is what tells them apart",
      ),
      true,
    );
  });

  test("a variable Companion could not have skips the button, creating NEITHER half", async () => {
    const button = await offered("house_lights_on");
    const r = await importing([{ ...button, stateVariable: "state:lights" }]);
    const { created, skipped } = r.json as { created: string[]; skipped: { name: string; why: string }[] };
    assert.deepEqual(created, []);
    assert.deepEqual(skipped.map((x) => x.name), ["house_lights_on"]);
    assert.match(skipped[0]!.why, /not a Companion variable name/);
    assert.equal(automationEngine.cueRules().length, 0, "half a pair was left behind");
  });

  test("a name found on two pages is still disambiguated by page, both halves", async () => {
    for (const rule of automationEngine.listRules()) await automationEngine.removeRule(rule.id);
    const real = companionDeps.fetch;
    companionDeps.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/press")) {
        presses.push(url);
        return new Response("ok", { status: 200 });
      }
      // "House Lights ON" now exists on page 2 as well, over another room.
      const doc = companionExportFixture() as {
        pages: Record<string, { controls: Record<string, Record<string, unknown>> }>;
      };
      doc.pages["2"]!.controls["2"] = { "1": doc.pages["1"]!.controls["2"]!["1"] };
      return Response.json(doc);
    };
    companionApi.invalidate();
    try {
      const buttons = (
        (await callRoute(cueRoutes, "/api/companion/pairs")).json as {
          buttons: Record<string, unknown>[];
        }
      ).buttons
        .filter((b) => slugOf(b).endsWith("house_lights_on"))
        .map((b) => ({ ...b, stateVariable: "house_lights_state" }));
      assert.deepEqual(buttons.map(slugOf), [
        "room_a_screens_house_lights_on",
        "room_a_lighting_house_lights_on",
      ]);
      const r = await importing(buttons);
      assert.deepEqual((r.json as { created: string[] }).created, [
        "room_a_screens_house_lights_on",
        "room_a_screens_house_lights_off",
        "room_a_lighting_house_lights_on",
        "room_a_lighting_house_lights_off",
      ]);
      // The WORDS carry the page too, or Home Assistant gets two switches both
      // called "House Lights".
      assert.deepEqual(
        automationEngine.cueRules().map((x) => String(x.trigger.params.says)),
        [
          "Room A: Screens House Lights on",
          "Room A: Screens House Lights off",
          "Room A: Lighting House Lights on",
          "Room A: Lighting House Lights off",
        ],
      );
    } finally {
      companionDeps.fetch = real;
      companionApi.invalidate();
    }
  });
});
