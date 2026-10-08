// The Messages widget: which messages it draws, for which groups, and what it
// says when it has nothing.
//
// jsdom loads no stylesheet and reports every size as 0, so how it LOOKS (the
// proportions, the colours, the card against the mockup) is not asserted here;
// it was compared to the approved mockup in a browser. These are the decisions.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
import { EVERYONE, type MessagesState, type StageMessage } from "@main/types/messages";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every request the widget makes, and how the reply route should answer. */
const requests: { url: string; method: string; body: unknown }[] = [];
let replyStatus = 201;
(globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
  if (url.includes("/replies")) {
    const ok = replyStatus < 400;
    const body = ok ? { id: "r" } : { error: "that widget does not follow a group this message was sent to" };
    return { ok, status: replyStatus, statusText: "", json: async () => body, text: async () => JSON.stringify(body) };
  }
  return { ok: true, status: 200, statusText: "", json: async () => ({}), text: async () => "{}" };
};

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const { toast } = await import("../components/ui/index.js");
const React = (await import("react")).default;
const { MessagesObject, groupNames, shownMessages } = await import("./messages-object.js");
const { ageLabel } = await import("../lib/age-label.js");

/** What the operator was told: toast.error is spied, not drawn. */
const toasts: string[] = [];
const realToastError = toast.error;
beforeEach(() => {
  toasts.length = 0;
  toast.error = (m: string) => void toasts.push(m);
});

after(() => {
  toast.error = realToastError;
  cleanup();
  teardown();
});

const GREEN = "g-00000001";
const STAGE = "g-00000002";
const BOOTH = "g-00000003";
const GROUPS = [
  { id: GREEN, name: "Green room" },
  { id: STAGE, name: "Stage" },
  { id: BOOTH, name: "Booth" },
];
const NOW = 1_000_000_000_000;

function msg(n: number, to: string[], over: Partial<StageMessage> = {}): StageMessage {
  return {
    id: n.toString(16).padStart(16, "0"),
    at: NOW - 60_000 * (10 - n),
    to,
    text: `message ${n}`,
    alert: false,
    alertUntil: null,
    clearedAt: null,
    from: "Producer console",
    replies: [],
    ...over,
  };
}

function stateOf(messages: StageMessage[], quickReplies: string[] = ["Copy", "Walking now", "Need 2 min"]): MessagesState {
  return { rev: 1, serverNow: NOW, groups: GROUPS, quickMessages: [], quickReplies, messages, alerts: [] };
}

function mount(over: Partial<React.ComponentProps<typeof MessagesObject>> = {}): HTMLElement {
  cleanup();
  const { container } = render(
    React.createElement(MessagesObject, {
      objectId: "w1",
      config: {},
      state: stateOf([]),
      known: true,
      screen: { outputId: "panel-1", groups: [GREEN] },
      interactive: false,
      editing: false,
      now: NOW,
      ts: {},
      ...over,
    }),
  );
  return container;
}

function draw(over: Partial<React.ComponentProps<typeof MessagesObject>> = {}): string {
  return mount(over).textContent ?? "";
}

describe("which messages it shows", () => {
  const state = stateOf([
    msg(1, [GREEN]),
    msg(2, [STAGE]),
    msg(3, [EVERYONE]),
    msg(4, [BOOTH, STAGE]),
    msg(5, [GREEN, BOOTH]),
    msg(6, [GREEN]),
  ]);

  test("the newest three for the groups, Everyone included, newest first", () => {
    assert.deepEqual(shownMessages(state, [GREEN]).map((m) => m.text), ["message 6", "message 5", "message 3"]);
    assert.deepEqual(shownMessages(state, [STAGE]).map((m) => m.text), ["message 4", "message 3", "message 2"]);
  });

  test("a screen in no group still gets Everyone", () => {
    assert.deepEqual(shownMessages(state, []).map((m) => m.text), ["message 3"]);
  });

  test("a screen's groups decide, so a message to another group is not drawn", () => {
    const text = draw({ state, screen: { outputId: "panel-1", groups: [STAGE] } });
    assert.ok(text.includes("message 4") && text.includes("message 2"), text);
    assert.ok(!text.includes("message 6") && !text.includes("message 1"), text);
  });

  test("its own groups override the screen's", () => {
    const text = draw({ state, screen: { outputId: "panel-1", groups: [STAGE] }, config: { groups: [GREEN] } });
    assert.ok(text.includes("message 6") && !text.includes("message 4"), text);
  });

  test("an empty list of its own is a list: only Everyone's messages", () => {
    const text = draw({ state, screen: { outputId: "panel-1", groups: [GREEN] }, config: { groups: [] } });
    assert.ok(text.includes("message 3"), text);
    assert.ok(!text.includes("message 6") && !text.includes("message 5"), text);
  });
});

describe("what it says with nothing to show", () => {
  test("no messages for its groups", () => {
    assert.ok(draw({ state: stateOf([msg(1, [STAGE])]) }).includes("No messages for this screen's groups"));
  });

  test("with no groups of its own the editor says it follows its screen; a console in the app says to choose; a wall or preview says nothing", () => {
    const editor = draw({ screen: null, editing: true });
    assert.ok(editor.includes("Follows the screen it is on") && !editor.includes("Choose groups"), editor);
    const console_ = draw({ screen: null, editing: false, interactive: true });
    assert.ok(console_.includes("Choose groups for this widget") && !console_.includes("No messages"), console_);
    const quiet = draw({ screen: null, editing: false, interactive: false });
    assert.ok(!quiet.includes("Choose groups") && !quiet.includes("Follows") && !quiet.includes("No messages"), quiet);
    assert.ok(quiet.includes("Messages"), "the heading still draws");
  });

  test("before the channel has answered it draws no claim, and a failed read is not 'no messages'", () => {
    // known=false: nothing answered. state=null with known=true: the read failed.
    for (const over of [{ known: false, state: null }, { known: true, state: null }, { known: false, state: stateOf([]) }]) {
      const text = draw(over);
      assert.ok(!text.includes("No messages"), `claimed "no messages" for ${JSON.stringify({ known: over.known, state: over.state === null })}: ${text}`);
    }
  });
});

describe("a message's line", () => {
  test("names the sender and the age against the clock it is given, and the latest reply under it", () => {
    const m = msg(9, [GREEN], {
      at: NOW - 3 * 60_000,
      replies: [
        { id: "r1", at: NOW - 120_000, from: "Booth console", text: "Copy" },
        { id: "r2", at: NOW - 60_000, from: "Green room iPad", text: "Walking now" },
      ],
    });
    const text = draw({ state: stateOf([m]) });
    assert.ok(text.includes("Producer console") && text.includes("3 min"), text);
    assert.ok(text.includes("Green room iPad: Walking now"), "the latest reply");
    assert.ok(!text.includes("Booth console: Copy"), "an earlier reply");
    // Same message, a clock a minute later: the age moves with `now`, so it is the
    // injected server clock being read and not the host's.
    assert.ok(draw({ state: stateOf([m]), now: NOW + 60_000 }).includes("4 min"));
  });

  test("an older message is muted but its reply keeps the green, as the mockup draws it", () => {
    const older = msg(1, [GREEN], { text: "older words", replies: [{ id: "r1", at: NOW - 30_000, from: "Booth console", text: "Copy" }] });
    const c = mount({ state: stateOf([older, msg(2, [GREEN])]) });
    const spans = [...c.querySelectorAll("span")];
    const words = spans.find((e) => e.textContent === "older words")!;
    const reply = spans.find((e) => e.textContent === "Booth console: Copy")!;
    assert.equal(words.style.opacity, "0.6", "the older message's words were not muted");
    // Nothing between the reply and the card may dim it: no ancestor carries an opacity.
    for (let el: HTMLElement | null = reply; el && el !== c; el = el.parentElement) {
      assert.equal(el.style.opacity, "", `the reply is dimmed by ${el.tagName} ${el.getAttribute("style")}`);
    }
  });

  test("ageLabel", () => {
    assert.equal(ageLabel(NOW, NOW - 10_000), "now");
    assert.equal(ageLabel(NOW, NOW + 5_000), "now", "a message stamped ahead of the clock is never negative");
    assert.equal(ageLabel(NOW, NOW - 45_000), "1 min");
    assert.equal(ageLabel(NOW, NOW - 89 * 60_000), "89 min");
    assert.equal(ageLabel(NOW, NOW - 3 * 3600_000), "3 h");
  });

  test("groupNames keeps the config's order and drops a deleted group", () => {
    assert.deepEqual(groupNames(GROUPS, [BOOTH, GREEN, "g-deadbeef"]), ["Green room", "Booth"]);
  });
});

// ---- answering ----------------------------------------------------------------

const buttons = (c: HTMLElement) => [...c.querySelectorAll("button")].map((b) => b.textContent);

describe("answering from a console", () => {
  const thread = stateOf([
    msg(1, [GREEN], { text: "an older one for the green room" }),
    msg(2, [STAGE], { text: "for the stage" }),
    msg(3, [GREEN], { text: "for the green room" }),
  ]);

  test("a console offers the quick replies under the newest message it shows", () => {
    const c = mount({ state: thread, interactive: true, screen: { outputId: "panel-1", groups: [GREEN] } });
    assert.deepEqual(buttons(c), ["Copy", "Walking now", "Need 2 min"]);
    assert.ok((c.textContent ?? "").includes("Answering: for the green room"), c.textContent ?? "");
  });

  test("a wall display shows no buttons and no answering line", () => {
    const c = mount({ state: thread, interactive: false, screen: { outputId: "panel-1", groups: [GREEN] } });
    assert.deepEqual(buttons(c), []);
    assert.ok(!(c.textContent ?? "").includes("Answering"), c.textContent ?? "");
  });

  test("with nothing to answer it says which groups this console can answer for", () => {
    // A message to Stage does not reach a console in Green room and Booth.
    const quiet = mount({ state: stateOf([msg(1, [STAGE])]), interactive: true, screen: { outputId: "panel-1", groups: [GREEN, BOOTH] } });
    assert.deepEqual(buttons(quiet), []);
    assert.ok((quiet.textContent ?? "").includes("Nothing to answer. This console can reply only to messages sent to Green room, Booth or Everyone."), quiet.textContent ?? "");
  });

  test("a console in no group can answer only Everyone, and says so", () => {
    const c = mount({ state: stateOf([msg(1, [STAGE])]), interactive: true, screen: { outputId: "panel-1", groups: [] } });
    assert.ok((c.textContent ?? "").includes("messages sent to Everyone."), c.textContent ?? "");
  });

  test("no buttons before the channel has answered, or where it follows no group", () => {
    assert.deepEqual(buttons(mount({ state: null, known: false, interactive: true })), []);
    assert.deepEqual(buttons(mount({ state: thread, interactive: true, screen: null })), []);
  });

  test("with no quick replies set up it says where to add them", () => {
    const c = mount({ state: stateOf([msg(1, [GREEN])], []), interactive: true });
    assert.deepEqual(buttons(c), []);
    assert.ok((c.textContent ?? "").includes("No quick replies are set up"), c.textContent ?? "");
  });

  test("pressing one sends the reply with this widget's id and screen, for the message it answers", async () => {
    requests.length = 0;
    replyStatus = 201;
    const c = mount({ state: thread, interactive: true, screen: { outputId: "panel-1", groups: [GREEN] }, objectId: "w-7" });
    await act(async () => {
      fireEvent.click([...c.querySelectorAll("button")].find((b) => b.textContent === "Walking now")!);
    });
    const posts = requests.filter((r) => r.method === "POST" && r.url.includes("/replies"));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `/api/messages/${thread.messages[2].id}/replies`, "answered a message that is not the newest this widget shows");
    assert.deepEqual(posts[0].body, { text: "Walking now", objectId: "w-7", outputId: "panel-1" });
  });

  test("a refused reply is told and logged, and the buttons stay for another try", async () => {
    requests.length = 0;
    replyStatus = 403;
    const quiet = console.warn;
    console.warn = () => {};
    try {
      const c = mount({ state: thread, interactive: true, screen: { outputId: "panel-1", groups: [GREEN] } });
      await act(async () => {
        fireEvent.click([...c.querySelectorAll("button")].find((b) => b.textContent === "Copy")!);
      });
      assert.deepEqual(buttons(c), ["Copy", "Walking now", "Need 2 min"], "the buttons went away after a failed reply");
      assert.ok((c.querySelector("button") as HTMLButtonElement).disabled === false, "left disabled after the failure");
    } finally {
      console.warn = quiet;
      replyStatus = 201;
    }
    const logged = requests.find((r) => r.url === "/api/log/client");
    assert.ok(logged, "the failure was not sent to /log");
    assert.deepEqual((logged!.body as { tag: string }).tag, "messages");
    assert.match((logged!.body as { message: string }).message, /could not send that reply \(to .*\): .*does not follow a group/);
    assert.deepEqual(toasts, ["Could not send that reply: that widget does not follow a group this message was sent to"], "the operator was not told");
  });
});
