// POST /api/messages/:id/replies — who may answer a message, decided on the
// server from the stored layouts and outputs.
//
// The browser is not trusted to say which groups it is in: the widget is found by
// the id it names, in every view's layout; its groups are its own list, or the
// output's; and the message's own `to` is what they are checked against. The
// sender of a reply is the output's name or the view's, never anything in the
// body. Driven through the real handler, service and a real data directory.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-messages-replies-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { messagesRoutes } = await import("./messages-routes.js");
const { callRoute } = await import("./route-harness.js");
const { messagesService } = await import("../messages-service.js");
const { messagesStore } = await import("../messages-store.js");
const { messagingStore } = await import("../messaging-store.js");
const { stageController } = await import("../stage-controller.js");
const { EVERYONE } = await import("../../types/messages.js");
type StageMessage = import("../../types/messages.js").StageMessage;
type MessageReply = import("../../types/messages.js").MessageReply;

const ctl = stageController as unknown as { state: { outputs: Output[]; views: View[]; [k: string]: unknown }; broadcast: () => void };
ctl.broadcast = () => {};

let green = "";
let stage = "";
let booth = "";

const send = async (to: string[], text = "Walk now"): Promise<StageMessage> =>
  (await callRoute(messagesRoutes, "/api/messages", { method: "POST", body: { to, text } })).json as StageMessage;
const reply = (id: string, body: unknown) =>
  callRoute(messagesRoutes, `/api/messages/${id}/replies`, { method: "POST", body });
const err = (r: { json: unknown }) => (r.json as { error?: string })?.error ?? "";
const thread = () => messagesService.state().messages;

/** A custom view holding the given objects. */
function viewOf(id: string, name: string, objects: unknown[]): View {
  return {
    id,
    name,
    kind: "custom",
    createdAt: "",
    layout: { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects },
  } as unknown as View;
}
const widget = (id: string, groups?: string[] | null) => ({
  id, x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "messages", ...(groups === undefined ? {} : { groups }) },
});

beforeEach(async () => {
  await messagesStore.save({ lastClearedDate: null, messages: [] });
  await messagesStore.reload();
  (messagesService as unknown as { messages: StageMessage[]; loaded: boolean }).messages = [];
  const { config } = await messagingStore.replace({
    version: messagingStore.get().version,
    groups: [{ name: "Green room" }, { name: "Stage" }, { name: "Booth" }],
    quickMessages: ["Walk now"],
    quickReplies: ["Copy"],
  });
  [green, stage, booth] = config.groups.map((g) => g.id);
  ctl.state = {
    ...ctl.state,
    views: [
      // Follows whatever screen draws it.
      viewOf("v-follow", "Booth console", [widget("w-follow")]),
      // Its own list, on a console.
      viewOf("v-own", "Green room iPad", [widget("w-green", [green]), widget("w-none", [])]),
      viewOf("v-elsewhere", "Elsewhere", [{ id: "clock-2", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "clock" } }]),
      viewOf("v-embeds", "Embeds", [{ id: "tile", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "view-embed", viewId: "v-follow" } }]),
      viewOf("v-screen-embeds", "Screen embeds", [{ id: "stile", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "screen-embed", outputId: "panel-1" } }]),
      // Nested in a container, and a widget of another type beside it.
      viewOf("v-nested", "Nested", [
        {
          id: "box", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "container" },
          children: [widget("w-deep", [stage])],
        },
        { id: "clock-1", x: 0, y: 0, w: 1, h: 1, z: 1, config: { type: "clock" } },
      ]),
    ],
    outputs: [
      { id: "panel-1", name: "Booth panel", viewId: "v-follow", mode: "panel", groups: [booth, stage] },
      { id: "wall", name: "Stage wall", viewId: "v-follow", mode: "display", groups: [stage] },
      { id: "plain", name: "Plain", viewId: "v-follow", groups: [stage] },
      // A real panel in Stage that draws a view with no Messages widget in it: not
      // somewhere w-follow is drawn, whatever a request says.
      { id: "victim", name: "Victim panel", viewId: "v-elsewhere", mode: "panel", groups: [stage, booth] },
      // A display showing the view that holds the own-groups widgets.
      { id: "own-wall", name: "Own wall", viewId: "v-own", mode: "display", groups: [green] },
      // A panel whose view embeds the follow view by view-embed, and one that
      // embeds another screen's view by screen-embed.
      { id: "embedder", name: "Embedder panel", viewId: "v-embeds", mode: "panel", groups: [booth] },
      { id: "screen-embedder", name: "Screen embedder", viewId: "v-screen-embeds", mode: "panel", groups: [booth] },
    ] as Output[],
  };
  (stageController as unknown as { recomputeResolved: () => void }).recomputeResolved();
});

describe("who may answer", () => {
  it("a widget with its own groups answers a message sent to one of them, signing as its view", async () => {
    const m = await send([green]);
    const r = await reply(m.id, { text: "Copy", objectId: "w-green" });
    assert.equal(r.status, 201, err(r));
    const rep = r.json as MessageReply;
    assert.deepEqual([rep.from, rep.text], ["Green room iPad", "Copy"]);
    assert.match(rep.id, /^[0-9a-f]{16}$/);
    assert.deepEqual(thread()[0].replies.map((x) => x.id), [rep.id], "the reply is on the message");
  });

  it("a widget that follows its screen answers for that screen's groups, signing as the output", async () => {
    const m = await send([booth]);
    const r = await reply(m.id, { text: "Walking now", objectId: "w-follow", outputId: "panel-1" });
    assert.equal(r.status, 201, err(r));
    assert.equal((r.json as MessageReply).from, "Booth panel");
  });

  it("Everyone reaches any Messages widget a screen draws, and any with a list of its own", async () => {
    const m = await send([EVERYONE]);
    assert.equal((await reply(m.id, { text: "Copy", objectId: "w-follow", outputId: "panel-1" })).status, 201);
    assert.equal((await reply(m.id, { text: "Copy", objectId: "w-none" })).status, 201);
  });

  it("a screen that draws the widget through a view-embed or a screen-embed answers for it", async () => {
    const m = await send([booth]);
    assert.equal((await reply(m.id, { text: "Copy", objectId: "w-follow", outputId: "embedder" })).status, 201, "view-embed");
    assert.equal((await reply(m.id, { text: "Copy", objectId: "w-follow", outputId: "screen-embedder" })).status, 201, "screen-embed");
  });

  it("a widget nested in a container is found", async () => {
    const m = await send([stage]);
    assert.equal((await reply(m.id, { text: "Copy", objectId: "w-deep" })).status, 201);
  });

  it("refuses 403 a widget whose groups the message did not go to, and records nothing", async () => {
    const m = await send([stage]);
    const r = await reply(m.id, { text: "Copy", objectId: "w-green" });
    assert.equal(r.status, 403);
    assert.match(err(r), /does not follow a group/);
    assert.deepEqual(thread()[0].replies, []);
  });

  it("refuses 403 a following widget whose screen is not in the message's group", async () => {
    const m = await send([green]);
    const r = await reply(m.id, { text: "Copy", objectId: "w-follow", outputId: "panel-1" });
    assert.equal(r.status, 403);
  });

  it("refuses 403 a following widget with no screen named: it has none to follow, Everyone's messages too", async () => {
    const m = await send([stage]);
    const r = await reply(m.id, { text: "Copy", objectId: "w-follow" });
    assert.equal(r.status, 403);
    assert.match(err(r), /follows a screen's groups/);
    const all = await send([EVERYONE]);
    assert.equal((await reply(all.id, { text: "Copy", objectId: "w-follow" })).status, 403);
    assert.equal((await reply(m.id, { text: "Copy", objectId: "w-follow", outputId: "nowhere" })).status, 403);
  });

  it("refuses 403 a request that names a real panel which does not draw the widget (the forged claim)", async () => {
    // w-follow is drawn by panel-1 and nobody called victim: naming victim must not
    // let the caller sign as it, though victim is in Stage and the message went there.
    const m = await send([stage]);
    const r = await reply(m.id, { text: "Copy", objectId: "w-follow", outputId: "victim" });
    assert.equal(r.status, 403);
    assert.match(err(r), /does not draw that widget/);
    assert.deepEqual(thread()[0].replies, []);
  });

  it("the same for a widget with groups of its own: a screen that does not draw it cannot claim it", async () => {
    const m = await send([green]);
    assert.equal((await reply(m.id, { text: "Copy", objectId: "w-green", outputId: "victim" })).status, 403);
    assert.equal((await reply(m.id, { text: "Copy", objectId: "w-green", outputId: "panel-1" })).status, 403);
  });

  it("an empty list of its own follows nothing, so only Everyone gets through", async () => {
    const m = await send([green]);
    assert.equal((await reply(m.id, { text: "Copy", objectId: "w-none" })).status, 403);
  });

  it("a display never answers, whatever groups it is in; a mode left unset is a display", async () => {
    const m = await send([stage]);
    for (const outputId of ["wall", "plain"]) {
      const r = await reply(m.id, { text: "Copy", objectId: "w-follow", outputId });
      assert.equal(r.status, 403, outputId);
      assert.match(err(r), /display cannot reply/);
    }
    // And a widget with groups of its own, drawn by a display that holds it: the
    // panel check is what refuses it, not the groups.
    const g = await send([green]);
    const own = await reply(g.id, { text: "Copy", objectId: "w-green", outputId: "own-wall" });
    assert.equal(own.status, 403);
    assert.match(err(own), /display cannot reply/);
    assert.deepEqual(thread().flatMap((x) => x.replies), []);
  });
});

describe("what it does not trust", () => {
  it("signs with the server's name for the screen, whatever the body says", async () => {
    const m = await send([booth]);
    const r = await reply(m.id, { text: "Copy", objectId: "w-follow", outputId: "panel-1", from: "Pastor", id: "mine", at: 1 });
    assert.equal(r.status, 201);
    const rep = r.json as MessageReply;
    assert.deepEqual([rep.from, rep.id === "mine", rep.at > 1_000_000], ["Booth panel", false, true]);
  });

  it("404 for an id that names no widget, a widget of another type, or no message", async () => {
    const m = await send([EVERYONE]);
    assert.equal((await reply(m.id, { text: "Copy", objectId: "nope" })).status, 404);
    assert.equal((await reply(m.id, { text: "Copy", objectId: "__proto__" })).status, 404);
    const other = await reply(m.id, { text: "Copy", objectId: "clock-1" });
    assert.equal(other.status, 404);
    assert.match(err(other), /no Messages widget/);
    assert.equal((await reply("0000000000000000", { text: "Copy", objectId: "w-follow" })).status, 404);
    assert.deepEqual(thread()[0].replies, []);
  });

  it("400 before any lookup for ids of the wrong shape and text that breaks a rule", async () => {
    const m = await send([EVERYONE]);
    assert.equal((await reply("__proto__", { text: "Copy", objectId: "w-follow" })).status, 400);
    for (const body of [
      { text: "Copy" },
      { text: "Copy", objectId: 7 },
      { text: "Copy", objectId: "has space" },
      { text: "Copy", objectId: "x".repeat(65) },
      { text: "Copy", objectId: "w-follow", outputId: "bad id" },
      { text: "Copy", objectId: "w-follow", outputId: 3 },
      { text: "", objectId: "w-follow" },
      { text: "x".repeat(61), objectId: "w-follow" },
      { objectId: "w-follow" },
    ]) {
      const r = await reply(m.id, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await callRoute(messagesRoutes, `/api/messages/${m.id}/replies`, { method: "POST", body: [1] })).status, 400);
    assert.deepEqual(thread()[0].replies, []);
  });

  it("a message cleared at midnight is a 404, not a reply to nothing", async () => {
    const m = await send([EVERYONE]);
    // The thread was last cleared yesterday: the day is rolled before the reply.
    (messagesService as unknown as { lastClearedDate: string }).lastClearedDate = "2000-01-01";
    const r = await reply(m.id, { text: "Copy", objectId: "w-follow" });
    assert.equal(r.status, 404);
    assert.deepEqual(thread(), []);
  });
});

describe("what it leaves behind", () => {
  it("persists the reply, publishes the state with it, and logs who answered what", async () => {
    const m = await send([booth]);
    const lines: string[] = [];
    const real = { log: console.log, warn: console.warn };
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.warn = console.log;
    try {
      await reply(m.id, { text: "Copy", objectId: "w-follow", outputId: "panel-1" });
      await reply(m.id, { text: "Copy", objectId: "w-green" });
    } finally {
      Object.assign(console, real);
    }
    assert.ok(lines.includes(`[messages] reply to ${m.id} from Booth panel: "Copy"`), lines.join("\n"));
    assert.ok(lines.some((l) => l.startsWith(`[messages] reply to ${m.id} refused: that widget does not follow a group`)), lines.join("\n"));
    const saved = await messagesStore.load();
    assert.deepEqual(saved.messages[0].replies.map((x) => [x.from, x.text]), [["Booth panel", "Copy"]]);
    const state = (await callRoute(messagesRoutes, "/api/messages")).json as { messages: StageMessage[] };
    assert.equal(state.messages[0].replies.length, 1);
  });
});
