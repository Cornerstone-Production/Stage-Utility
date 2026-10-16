// The two stage message actions a rule fires and an Action button presses:
// `messages.send` and `messages.clear-alerts`.
//
// What matters is that they go through the SAME service as a console's send
// (so the same rules refuse the same things), that a refusal is a RETURNED
// failure and never a throw out of the engine, that a simulated run sends
// nothing, and that a rule saved with nothing to say shows Needs setup.
//
// Persistence is real, against a data directory of its own. Group ids are issued
// by the messaging store and read back. Every name below is invented.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "messages-actions-"));
process.env.STAGE_UTILITY_DATA = DATA;
process.env.HOME = path.join(DATA, "home");

const { AUTOMATION_ACTIONS } = await import("./automation-actions.js");
const { ruleIssues, validateParams } = await import("./automation-param-validation.js");
const { messagesService } = await import("./messages-service.js");
const { messagingStore } = await import("./messaging-store.js");
const { invokeAction } = await import("./action-invoke.js");
const { EVERYONE } = await import("../types/messages.js");

const send = AUTOMATION_ACTIONS["messages.send"]!;
const clearAlerts = AUTOMATION_ACTIONS["messages.clear-alerts"]!;

const real = { log: console.log, warn: console.warn, error: console.error };
let green = "";
let stage = "";

beforeEach(async () => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  const { config } = await messagingStore.replace({
    version: messagingStore.get().version,
    groups: [{ name: "Green room" }, { name: "Stage" }],
    quickMessages: [],
    quickReplies: [],
  });
  [green, stage] = config.groups.map((g) => g.id);
  // End whatever an earlier case left running, so each starts with no alert.
  for (const m of messagesService.state().alerts) await messagesService.clearAlert(m.id);
});
afterEach(() => {
  Object.assign(console, real);
  mock.restoreAll();
});

const thread = () => messagesService.state().messages;
const last = () => thread().at(-1)!;

describe("messages.send", () => {
  test("sends through the messages service, from Automation, to the groups in the config's order", async () => {
    const spy = mock.method(messagesService, "send");
    const r = await send.run({ to: `${stage},${green}`, text: "  Walk now ", alert: "no" }, { simulate: false });
    assert.equal(r.ok, true, r.detail);
    assert.equal(spy.mock.callCount(), 1);
    assert.deepEqual(spy.mock.calls[0]!.arguments[0], { to: [stage, green], text: "  Walk now ", alert: false, from: "Automation" });
    assert.equal(last().from, "Automation");
    assert.deepEqual(last().to, [green, stage]);
    assert.equal(last().text, "Walk now");
    assert.equal(last().alert, false);
    assert.match(r.detail, /^sent to Green room, Stage: "Walk now"$/);
  });

  test("sends to Everyone, and an alert is an alert", async () => {
    const r = await send.run({ to: EVERYONE, text: "Doors open", alert: "yes" }, { simulate: false });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(last().to, [EVERYONE]);
    assert.equal(last().alert, true);
    assert.equal(messagesService.state().alerts[0]!.id, last().id);
    assert.match(r.detail, /^sent to Everyone \(alert\)/);
  });

  test("alert reads yes, true and \"true\" as an alert, and no, false, \"false\" and blank as none", async () => {
    // POST /api/action/invoke carries JSON, where a boolean is the natural way to say it.
    for (const [alert, expected] of [["yes", true], [true, true], ["true", true], ["no", false], [false, false], ["false", false], ["", false], [undefined, false]] as const) {
      const r = await send.run({ to: EVERYONE, text: "hi", alert }, { simulate: false });
      assert.equal(r.ok, true, `${String(alert)}: ${r.detail}`);
      assert.equal(last().alert, expected, `alert ${JSON.stringify(alert)}`);
      for (const m of messagesService.state().alerts) await messagesService.clearAlert(m.id);
    }
  });

  test("an alert value it does not recognise is a returned failure naming it, and nothing is sent", async () => {
    const before = thread().length;
    for (const alert of ["maybe", 1, "Yes please"]) {
      const real = await send.run({ to: EVERYONE, text: "hi", alert }, { simulate: false });
      assert.deepEqual(real, { ok: false, detail: `not sent: alert must be yes or no, not ${JSON.stringify(alert)}` });
      const dry = await send.run({ to: EVERYONE, text: "hi", alert }, { simulate: true });
      assert.equal(dry.ok, false);
    }
    assert.equal(thread().length, before);
  });

  test("a blank alert is no alert", async () => {
    const r = await send.run({ to: EVERYONE, text: "hi" }, { simulate: false });
    assert.equal(r.ok, true, r.detail);
    assert.equal(last().alert, false);
  });

  test("a group deleted since the rule was saved is a returned failure naming it, not a throw", async () => {
    const before = thread().length;
    // Resolves rather than rejects: the engine does not have to catch it.
    const r = await send.run({ to: `${green},g-deadbeef`, text: "hi", alert: "no" }, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /^not sent: no group has the id g-deadbeef$/);
    assert.equal(thread().length, before, "a message went out despite the refusal");
  });

  test("a refusal from the service is a failure whatever it is: Everyone beside a group, an empty message", async () => {
    const both = await send.run({ to: `${EVERYONE},${green}`, text: "hi" }, { simulate: false });
    assert.equal(both.ok, false);
    assert.match(both.detail, /cannot be combined/);
    const blank = await send.run({ to: EVERYONE, text: "   " }, { simulate: false });
    assert.equal(blank.ok, false);
    assert.match(blank.detail, /cannot be empty/);
    const none = await send.run({ to: "", text: "hi" }, { simulate: false });
    assert.equal(none.ok, false);
    assert.match(none.detail, /at least one group/);
  });

  test("a send that cannot be saved is a returned failure too", async () => {
    mock.method(messagesService, "send", async () => {
      throw new Error("disk full");
    });
    const r = await send.run({ to: EVERYONE, text: "hi" }, { simulate: false });
    assert.deepEqual(r, { ok: false, detail: "not sent: disk full" });
  });

  test("simulate says what it would send and sends nothing", async () => {
    const spy = mock.method(messagesService, "send");
    const before = thread().length;
    const r = await send.run({ to: green, text: "hi", alert: "yes" }, { simulate: true });
    assert.deepEqual(r, { ok: true, detail: 'would send to Green room (alert): "hi"' });
    assert.equal(spy.mock.callCount(), 0, "simulate reached the service");
    assert.equal(thread().length, before);
    assert.equal(messagesService.state().alerts.length, 0);
  });

  test("simulate still refuses what a real run would, so a rule is tested before Sunday", async () => {
    const r = await send.run({ to: "g-deadbeef", text: "hi" }, { simulate: true });
    assert.equal(r.ok, false);
    assert.match(r.detail, /no group has the id g-deadbeef/);
  });

  test("through the console route a refusal is the same returned failure", async () => {
    const r = await invokeAction("messages.send", { to: "g-deadbeef", text: "hi" });
    assert.equal(r.ok, false);
    assert.match(r.detail, /no group has the id/);
  });
});

describe("messages.send params", () => {
  test("a rule saved with no groups or no text needs setup, on those fields only", () => {
    assert.deepEqual(
      validateParams(send.params, {}).map((i) => i.key),
      ["to", "text"],
    );
    assert.deepEqual(
      validateParams(send.params, { to: " , ", text: "   " }).map((i) => i.key),
      ["to", "text"],
    );
    assert.deepEqual(validateParams(send.params, { to: green, text: "hi" }), []);
  });

  test("Everyone beside a group needs setup before it ever fires", () => {
    const issues = validateParams(send.params, { to: `${EVERYONE},${green}`, text: "hi" });
    assert.deepEqual(issues.map((i) => i.key), ["to"]);
  });

  test("a saved rule with nothing to send is flagged by the same check the rules list runs, naming both fields", () => {
    const issues = ruleIssues(
      { trigger: { id: "service.live", params: {} }, conditions: [], action: { id: "messages.send", params: { alert: "no" } } },
      (kind, id) => {
        const def = kind === "action" ? AUTOMATION_ACTIONS[id] : undefined;
        return def ? { label: def.label, params: def.params } : null;
      },
    );
    assert.deepEqual(issues.map((i) => [i.step, i.label, i.message]), [
      ["action", "To", "Pick at least one"],
      ["action", "Message", "Required — 1 to 280 characters."],
    ]);
  });

  test("the alert choice may be left blank: it defaults to no", () => {
    const alert = send.params.find((p) => p.key === "alert")!;
    assert.equal(alert.default, "no");
    assert.equal(alert.optional, true);
  });
});

describe("messages.clear-alerts", () => {
  test("ends every running alert, from Automation, and leaves the messages in the thread", async () => {
    const a = await messagesService.send({ to: [green], text: "one", alert: true });
    const b = await messagesService.send({ to: [stage], text: "two", alert: true });
    const quiet = await messagesService.send({ to: [EVERYONE], text: "no alert" });
    assert.equal(messagesService.state().alerts.length, 2);
    const spy = mock.method(messagesService, "clearAlert");

    const r = await clearAlerts.run({}, { simulate: false });

    assert.deepEqual(r, { ok: true, detail: "ended 2 alerts" });
    assert.equal(messagesService.state().alerts.length, 0);
    assert.deepEqual(spy.mock.calls.map((c) => c.arguments.join("|")).sort(), [`${a.id}|Automation`, `${b.id}|Automation`].sort());
    const ids = thread().map((m) => m.id);
    for (const m of [a, b, quiet]) assert.ok(ids.includes(m.id), "an ended alert left the thread");
    assert.notEqual(thread().find((m) => m.id === a.id)!.clearedAt, null);
  });

  test("nothing running is a success that says so", async () => {
    const spy = mock.method(messagesService, "clearAlert");
    const r = await clearAlerts.run({}, { simulate: false });
    assert.deepEqual(r, { ok: true, detail: "no alert was running" });
    assert.equal(spy.mock.callCount(), 0);
  });

  test("simulate counts the alerts and ends none", async () => {
    await messagesService.send({ to: [green], text: "one", alert: true });
    const spy = mock.method(messagesService, "clearAlert");
    const r = await clearAlerts.run({}, { simulate: true });
    assert.deepEqual(r, { ok: true, detail: "would end 1 running alert" });
    assert.equal(spy.mock.callCount(), 0, "simulate ended an alert");
    assert.equal(messagesService.state().alerts.length, 1);
  });

  test("an alert that could not be ended is a returned failure, and the others are still ended", async () => {
    const older = await messagesService.send({ to: [green], text: "one", alert: true });
    const newest = await messagesService.send({ to: [stage], text: "two", alert: true });
    const realClear = messagesService.clearAlert.bind(messagesService);
    // The NEWEST throws, and it is tried first: stopping at the first failure
    // would leave the older one running.
    mock.method(messagesService, "clearAlert", async (id: string, from?: unknown) => {
      if (id === newest.id) throw new Error("disk full");
      return realClear(id, from);
    });
    const r = await clearAlerts.run({}, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /^ended 1 of 2 alerts; could not end 1: disk full$/);
    assert.deepEqual(messagesService.state().alerts.map((a) => a.id), [newest.id]);
    assert.notEqual(thread().find((m) => m.id === older.id)!.clearedAt, null, "the older alert was left running");
  });

  test("when every alert fails it says how many could not be ended", async () => {
    await messagesService.send({ to: [green], text: "one", alert: true });
    await messagesService.send({ to: [stage], text: "two", alert: true });
    mock.method(messagesService, "clearAlert", async () => {
      throw new Error("disk full");
    });
    const r = await clearAlerts.run({}, { simulate: false });
    assert.deepEqual(r, { ok: false, detail: "ended 0 of 2 alerts; could not end 2: disk full" });
  });

  test("an alert that ran out between the read and the clear is not a failure", async () => {
    await messagesService.send({ to: [green], text: "one", alert: true });
    const newest = await messagesService.send({ to: [stage], text: "two", alert: true });
    const realClear = messagesService.clearAlert.bind(messagesService);
    mock.method(messagesService, "clearAlert", async (id: string, from?: unknown) =>
      id === newest.id ? "not-running" : realClear(id, from),
    );
    const r = await clearAlerts.run({}, { simulate: false });
    assert.deepEqual(r, { ok: true, detail: "ended 1 alert" });
  });

  test("takes no params", () => {
    assert.deepEqual(clearAlerts.params, []);
  });
});
