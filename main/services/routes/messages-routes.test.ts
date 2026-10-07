// The stage-messages HTTP surface, driven through the real handler, the real
// service and a real data directory: every route, every 400 and 404, and what a
// client connecting mid-service is handed.
//
// The rules themselves (limits, ordering, the clock) are messages-service.test.ts
// and messaging-store.test.ts. This file is the boundary: which status a refusal
// is, that a body cannot choose the fields the server stamps, that a failed write
// is NOT dressed up as a refusal, and that nothing is looked up by an id that is
// not the shape the server issues.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-messages-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { messagesRoutes } = await import("./messages-routes.js");
const { callRoute } = await import("./route-harness.js");
const { messagesService } = await import("../messages-service.js");
const { messagesStore } = await import("../messages-store.js");
const { messagingStore } = await import("../messaging-store.js");
const { stageController } = await import("../stage-controller.js");
const { ROUTE_MODULES } = await import("../remote-server.js");
const { EVERYONE } = await import("../../types/messages.js");
type MessagesState = import("../../types/messages.js").MessagesState;
type StageMessage = import("../../types/messages.js").StageMessage;
type MessagingConfig = import("../../types/messages.js").MessagingConfig;

const ctl = stageController as unknown as { state: { outputs: Output[]; views: View[]; [k: string]: unknown }; broadcast: () => void };
ctl.broadcast = () => {};

let green = "";
let stage = "";

const send = (body: unknown) => callRoute(messagesRoutes, "/api/messages", { method: "POST", body });
const err = (r: { json: unknown }) => (r.json as { error?: string })?.error ?? "";

beforeEach(async () => {
  await messagesStore.save({ lastClearedDate: null, messages: [] });
  await messagesStore.reload();
  // A fresh in-memory thread: the singleton reads the store once, so reset it.
  (messagesService as unknown as { messages: StageMessage[]; loaded: boolean }).messages = [];
  const { config } = await messagingStore.replace({
    groups: [{ name: "Green room" }, { name: "Stage" }],
    quickMessages: ["Walk now"],
    quickReplies: ["Copy"],
  });
  [green, stage] = config.groups.map((g) => g.id);
  ctl.state = {
    ...ctl.state,
    views: [{ id: "v1", name: "Mic board", kind: "slots", createdAt: "" }] as View[],
    outputs: [
      { id: "wall", name: "Stage wall", viewId: "v1", groups: [green, stage] },
      { id: "foh", name: "FOH", viewId: "v1", groups: [stage] },
    ] as Output[],
  };
  (stageController as unknown as { recomputeResolved: () => void }).recomputeResolved();
});

describe("the module is dispatched", () => {
  it("is in ROUTE_MODULES, so its paths are answered by the server and not 404", () => {
    assert.ok(ROUTE_MODULES.includes(messagesRoutes), "messagesRoutes is not in remote-server's ROUTE_MODULES");
  });

  it("leaves a method or path it does not own for the next module", async () => {
    for (const [method, p] of [
      ["DELETE", "/api/messages"],
      ["PATCH", "/api/messaging"],
      ["GET", "/api/messages/0123456789abcdef/clear-alert"],
      ["POST", "/api/messages/0123456789abcdef"],
      ["GET", "/api/message"],
    ] as const) {
      const r = await callRoute(messagesRoutes, p, { method });
      assert.equal(r.responded, false, `${method} ${p} was answered`);
    }
  });
});

describe("POST /api/messages", () => {
  it("sends, answers 201 with the message, and GET shows it", async () => {
    const r = await send({ to: [stage], text: "  Walk now  ", from: "FOH" });
    assert.equal(r.status, 201);
    const m = r.json as StageMessage;
    assert.deepEqual([m.text, m.from, m.to, m.alert, m.alertUntil], ["Walk now", "FOH", [stage], false, null]);

    const state = (await callRoute(messagesRoutes, "/api/messages")).json as MessagesState;
    assert.deepEqual(state.messages.map((x) => x.id), [m.id]);
    assert.deepEqual(state.groups.map((g) => g.name), ["Green room", "Stage"]);
    assert.equal(state.alert, null);
  });

  it("sends an alert to Everyone, and the state names it", async () => {
    const r = await send({ to: [EVERYONE], text: "now", alert: true });
    assert.equal(r.status, 201);
    const m = r.json as StageMessage;
    assert.equal(m.alertUntil, m.at + 30_000);
    const state = (await callRoute(messagesRoutes, "/api/messages")).json as MessagesState;
    assert.equal(state.alert?.id, m.id);
  });

  it("cannot choose the fields the server stamps", async () => {
    const r = await send({ to: [EVERYONE], text: "x", id: "mine", at: 1, alertUntil: 9, clearedAt: 3, replies: [{ text: "forged" }] });
    const m = r.json as StageMessage;
    assert.notEqual(m.id, "mine");
    assert.ok(m.at > 1_000_000);
    assert.deepEqual([m.alertUntil, m.clearedAt, m.replies], [null, null, []]);
  });

  const refused: [string, unknown, RegExp][] = [
    ["a body that is not an object", [1, 2], /body must be/],
    ["a JSON null", null, /at least one group/],
    ["no recipients", { to: [], text: "x" }, /at least one group/],
    ["a group that does not exist", { to: ["g-00000000"], text: "x" }, /no group has the id/],
    ["Everyone beside a group", { to: [EVERYONE, "g-00000000"], text: "x" }, /cannot be combined/],
    ["empty text", { to: [EVERYONE], text: "" }, /cannot be empty/],
    ["text past 280 characters", { to: [EVERYONE], text: "x".repeat(281) }, /at most 280/],
    ["an alert flag that is not a boolean", { to: [EVERYONE], text: "x", alert: 1 }, /true or false/],
    ["a sender past 60 characters", { to: [EVERYONE], text: "x", from: "f".repeat(61) }, /at most 60/],
  ];
  for (const [what, body, reason] of refused) {
    it(`refuses ${what} with a 400 that says why, and sends nothing`, async () => {
      const r = await send(body);
      assert.equal(r.status, 400);
      assert.match(err(r), reason);
      assert.deepEqual(messagesService.state().messages, []);
    });
  }

  it("a body that is not JSON is a 400 with the reason, not a 500", async () => {
    const r = await callRoute(messagesRoutes, "/api/messages", { method: "POST", raw: "{nope" });
    assert.equal(r.status, 400);
    assert.match(err(r), /at least one group/);
    assert.deepEqual(messagesService.state().messages, []);
  });

  it("a failed write is a failure, not a refusal: the error is left for the server's handler", async () => {
    const real = messagesStore.save.bind(messagesStore);
    messagesStore.save = (async () => {
      throw new Error("ENOSPC: no space left on device");
    }) as typeof messagesStore.save;
    const quiet = console.error;
    console.error = () => {};
    try {
      await assert.rejects(() => send({ to: [EVERYONE], text: "x" }), /ENOSPC/);
    } finally {
      messagesStore.save = real;
      console.error = quiet;
    }
    assert.deepEqual(messagesService.state().messages, []);
  });
});

describe("POST /api/messages/:id/clear-alert", () => {
  const clear = (id: string, body?: unknown) =>
    callRoute(messagesRoutes, `/api/messages/${id}/clear-alert`, { method: "POST", body });

  it("ends a running alert and answers 200 with the state", async () => {
    const m = (await send({ to: [EVERYONE], text: "now", alert: true })).json as StageMessage;
    const r = await clear(m.id, { from: "Booth" });
    assert.equal(r.status, 200);
    const state = r.json as MessagesState;
    assert.equal(state.alert, null);
    assert.ok(state.messages.find((x) => x.id === m.id)?.clearedAt, "the message must stay, with clearedAt set");
  });

  it("answers 200 again for one already over, and for a message that was never an alert", async () => {
    const alert = (await send({ to: [EVERYONE], text: "a", alert: true })).json as StageMessage;
    const plain = (await send({ to: [EVERYONE], text: "p" })).json as StageMessage;
    assert.equal((await clear(alert.id)).status, 200);
    assert.equal((await clear(alert.id)).status, 200);
    assert.equal((await clear(plain.id)).status, 200);
  });

  it("answers 404 for an id nobody issued", async () => {
    const r = await clear("0000000000000000");
    assert.equal(r.status, 404);
    assert.match(err(r), /no message has that id/);
  });

  it("answers 400, before any lookup, for an id that is not the shape the server issues", async () => {
    for (const bad of ["__proto__", "constructor", "short", "0123456789ABCDEF", "0123456789abcdef0", "g-12345678"]) {
      const r = await clear(bad);
      assert.equal(r.status, 400, `${bad} reached the lookup`);
      assert.match(err(r), /not a message id/);
    }
  });

  it("refuses a sender it cannot name with a 400 and leaves the alert running", async () => {
    const m = (await send({ to: [EVERYONE], text: "now", alert: true })).json as StageMessage;
    const r = await clear(m.id, { from: "" });
    assert.equal(r.status, 400);
    assert.notEqual(messagesService.state().alert, null);
  });

  it("takes no body at all", async () => {
    const m = (await send({ to: [EVERYONE], text: "now", alert: true })).json as StageMessage;
    assert.equal((await clear(m.id)).status, 200);
  });
});

describe("GET and PUT /api/messaging", () => {
  const put = (body: unknown) => callRoute(messagesRoutes, "/api/messaging", { method: "PUT", body });

  it("GET answers the config", async () => {
    const r = await callRoute(messagesRoutes, "/api/messaging");
    assert.equal(r.status, 200);
    const cfg = r.json as MessagingConfig;
    assert.deepEqual(cfg.groups.map((g) => g.name), ["Green room", "Stage"]);
    assert.deepEqual([cfg.quickMessages, cfg.quickReplies], [["Walk now"], ["Copy"]]);
  });

  it("PUT replaces it, answers 200 with what is stored, and issues ids to new groups", async () => {
    const r = await put({ groups: [{ id: green, name: "Greenroom" }, { name: "Booth" }], quickMessages: ["Go"], quickReplies: [] });
    assert.equal(r.status, 200);
    const cfg = r.json as MessagingConfig;
    assert.equal(cfg.groups[0].id, green);
    assert.match(cfg.groups[1].id, /^g-[0-9a-f]{8}$/);
    assert.deepEqual((await callRoute(messagesRoutes, "/api/messaging")).json, cfg);
  });

  it("PUT removing a group takes it off every screen", async () => {
    const r = await put({ groups: [{ id: green, name: "Green room" }], quickMessages: [], quickReplies: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(stageController.getState().outputs.map((o) => [o.id, o.groups]), [["wall", [green]], ["foh", []]]);
    const state = (await callRoute(messagesRoutes, "/api/messages")).json as MessagesState;
    assert.deepEqual(state.groups.map((g) => g.id), [green], "GET /api/messages still lists the deleted group");
  });

  it("PUT with a body that is not JSON is a 400 with the reason, and changes nothing", async () => {
    const r = await callRoute(messagesRoutes, "/api/messaging", { method: "PUT", raw: "{nope" });
    assert.equal(r.status, 400);
    assert.match(err(r), /groups \(array\) is required/);
    assert.deepEqual(messagingStore.get().groups.map((g) => g.id), [green, stage]);
  });

  const refused: [string, unknown, RegExp][] = [
    ["a body that is not an object", "groups", /body must be/],
    ["groups missing", { quickMessages: [], quickReplies: [] }, /groups \(array\) is required/],
    ["an empty group name", { groups: [{ name: " " }], quickMessages: [], quickReplies: [] }, /cannot be empty/],
    ["a duplicate group name", { groups: [{ name: "A" }, { name: "a" }], quickMessages: [], quickReplies: [] }, /two groups are named/],
    ["a group id nobody issued", { groups: [{ id: "g-00000000", name: "A" }], quickMessages: [], quickReplies: [] }, /no group has the id/],
    ["an id that is not a group id", { groups: [{ id: "__proto__", name: "A" }], quickMessages: [], quickReplies: [] }, /not one this app issued/],
    ["25 quick messages", { groups: [], quickMessages: Array.from({ length: 25 }, (_, i) => `m${i}`), quickReplies: [] }, /at most 24/],
    ["13 quick replies", { groups: [], quickMessages: [], quickReplies: Array.from({ length: 13 }, (_, i) => `r${i}`) }, /at most 12/],
  ];
  for (const [what, body, reason] of refused) {
    it(`PUT refuses ${what} with a 400 that says why, and changes nothing`, async () => {
      const r = await put(body);
      assert.equal(r.status, 400);
      assert.match(err(r), reason);
      assert.deepEqual(messagingStore.get().groups.map((g) => g.id), [green, stage]);
      assert.deepEqual(stageController.getState().outputs.map((o) => o.groups), [[green, stage], [stage]]);
    });
  }
});

describe("the hello burst", () => {
  it("hydrates messages:state with the day's thread, so a screen that connects mid-alert shows it", async () => {
    const { writeHelloBurst } = await import("../remote-server.js");
    const m = (await send({ to: [EVERYONE], text: "now", alert: true })).json as StageMessage;
    const sink = { collected: [] as { channel: string; serialized: string }[] };
    writeHelloBurst(sink);
    const frame = sink.collected.find((f) => f.channel === "messages:state");
    assert.ok(frame, `the burst did not hydrate messages:state: ${sink.collected.map((f) => f.channel).join(", ")}`);
    const payload = JSON.parse(frame.serialized) as MessagesState;
    assert.equal(payload.alert?.id, m.id);
    assert.deepEqual(payload.messages.map((x) => x.id), [m.id]);
    assert.deepEqual(payload.groups.map((g) => g.name), ["Green room", "Stage"]);
  });
});
