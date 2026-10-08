// The Message composer widget: what it sends, to whom, and what it keeps when a
// send fails. Driven through the real component and the real invoke() over a
// stubbed fetch, so a press is followed to the request it makes.
//
// jsdom loads no stylesheet and reports every size as 0, so how it LOOKS (the
// chips, the two-column quick messages, the red Send alert against the
// mockup) is not asserted here; it was compared to the approved mockup in a
// browser. These are the decisions.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
import { ALERT_MS, EVERYONE, type MessagesState, type StageMessage } from "@main/types/messages";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
let failWith: { status: number; error: string } | null = null;
(globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
  const mutating = url === "/api/messages" || url.endsWith("/clear-alert");
  if (mutating && failWith) {
    const body = { error: failWith.error };
    return { ok: false, status: failWith.status, statusText: "", json: async () => body, text: async () => JSON.stringify(body) };
  }
  return { ok: true, status: 200, statusText: "", json: async () => ({}), text: async () => "{}" };
};
const posts = () => requests.filter((r) => r.method === "POST" && !r.url.startsWith("/api/log"));

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { MessageComposerObject, liveTargets, reachLine, senderName, toggleTarget } = await import("./message-composer-object.js");

after(() => {
  cleanup();
  teardown();
});
beforeEach(() => {
  requests.length = 0;
  failWith = null;
});

const GREEN = "g-00000001";
const STAGE = "g-00000002";
const GROUPS = [
  { id: GREEN, name: "Green room" },
  { id: STAGE, name: "Stage" },
];
const NOW = 1_000_000_000_000;

function msg(n: number, over: Partial<StageMessage> = {}): StageMessage {
  return {
    id: n.toString(16).padStart(16, "0"),
    at: NOW - 60_000 * (10 - n),
    to: [GREEN],
    text: `message ${n}`,
    alert: false,
    alertUntil: null,
    clearedAt: null,
    from: "Producer console",
    replies: [],
    ...over,
  };
}

function stateOf(messages: StageMessage[] = [], quickMessages = ["Walk now", "2 minutes"]): MessagesState {
  return { rev: 1, serverNow: NOW, groups: GROUPS, quickMessages, quickReplies: ["Copy"], messages, alerts: [] };
}

const OUTPUTS = [{ groups: [GREEN] }, { groups: [GREEN, STAGE] }, { groups: [] }];

function mount(over: Partial<React.ComponentProps<typeof MessageComposerObject>> = {}): HTMLElement {
  cleanup();
  return render(
    React.createElement(MessageComposerObject, {
      state: stateOf(),
      known: true,
      outputs: OUTPUTS,
      from: "Booth console",
      interactive: true,
      now: NOW,
      ts: {},
      ...over,
    }),
  ).container;
}

const text = (c: HTMLElement) => c.textContent ?? "";
const button = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const box = (c: HTMLElement) => c.querySelector("textarea") as HTMLTextAreaElement;
const press = (b: HTMLElement | undefined) => act(async () => { fireEvent.click(b!); });
const type = (c: HTMLElement, value: string) => act(async () => { fireEvent.change(box(c), { target: { value } }); });
const pressed = (c: HTMLElement, name: string) => button(c, name)?.getAttribute("aria-pressed");

describe("who a message goes to", () => {
  test("Everyone stands alone; groups add up; pressing a group swaps Everyone out", () => {
    assert.deepEqual(toggleTarget([], EVERYONE), [EVERYONE]);
    assert.deepEqual(toggleTarget([EVERYONE], EVERYONE), []);
    assert.deepEqual(toggleTarget([GREEN], STAGE), [GREEN, STAGE]);
    assert.deepEqual(toggleTarget([GREEN, STAGE], GREEN), [STAGE]);
    assert.deepEqual(toggleTarget([EVERYONE], GREEN), [GREEN], "Everyone stayed beside a group");
    assert.deepEqual(toggleTarget([GREEN, STAGE], EVERYONE), [EVERYONE], "groups stayed beside Everyone");
  });

  test("the chips are Everyone and each group, none picked to begin with", () => {
    const c = mount();
    assert.deepEqual(
      ["Everyone", "Green room", "Stage"].map((n) => pressed(c, n)),
      ["false", "false", "false"],
    );
  });

  test("pressing chips picks and swaps them", async () => {
    const c = mount();
    await press(button(c, "Green room"));
    await press(button(c, "Stage"));
    assert.deepEqual(["Everyone", "Green room", "Stage"].map((n) => pressed(c, n)), ["false", "true", "true"]);
    await press(button(c, "Everyone"));
    assert.deepEqual(["Everyone", "Green room", "Stage"].map((n) => pressed(c, n)), ["true", "false", "false"]);
  });

  test("a group deleted while it was picked leaves the choice: it is not sent, counted or named", async () => {
    cleanup();
    // Settings removes Green room after it was picked: the chip goes, and the picked id would have stayed.
    const only = { ...stateOf(), groups: [{ id: STAGE, name: "Stage" }] };
    const view = render(React.createElement(MessageComposerObject, { state: stateOf(), known: true, outputs: OUTPUTS, from: "Booth console", interactive: true, now: NOW, ts: {} }));
    await act(async () => { fireEvent.click(button(view.container, "Green room")!); fireEvent.click(button(view.container, "Stage")!); });
    await act(async () => { fireEvent.change(view.container.querySelector("textarea")!, { target: { value: "Walk now" } }); });
    view.rerender(React.createElement(MessageComposerObject, { state: only, known: true, outputs: OUTPUTS, from: "Booth console", interactive: true, now: NOW, ts: {} }));
    await act(async () => {});
    assert.ok(text(view.container).includes("Reaches 1 screen in Stage."), text(view.container));
    await press(button(view.container, "Send"));
    assert.deepEqual(posts().map((r) => r.body?.to), [[STAGE]], "the deleted group was still sent");
    // And with only the deleted group picked, nothing can be sent and the hint says to pick.
    requests.length = 0;
    cleanup();
    const v2 = render(React.createElement(MessageComposerObject, { state: stateOf(), known: true, outputs: OUTPUTS, from: "x", interactive: true, now: NOW, ts: {} }));
    await act(async () => { fireEvent.click(button(v2.container, "Green room")!); });
    await act(async () => { fireEvent.change(v2.container.querySelector("textarea")!, { target: { value: "hi" } }); });
    v2.rerender(React.createElement(MessageComposerObject, { state: only, known: true, outputs: OUTPUTS, from: "x", interactive: true, now: NOW, ts: {} }));
    await act(async () => {});
    assert.ok(text(v2.container).includes("Pick who this goes to."), text(v2.container));
    assert.equal(button(v2.container, "Send")!.disabled, true);
    assert.deepEqual(liveTargets([GREEN, STAGE, EVERYONE], only.groups), [STAGE, EVERYONE]);
  });

  test("reachLine says how many screens, and what an alert does", () => {
    assert.equal(reachLine([], false, GROUPS, OUTPUTS), "Pick who this goes to.");
    assert.equal(reachLine([GREEN], false, GROUPS, OUTPUTS), "Reaches 2 screens in Green room.");
    assert.equal(reachLine([STAGE], false, GROUPS, OUTPUTS), "Reaches 1 screen in Stage.");
    assert.equal(reachLine([GREEN, STAGE], false, GROUPS, OUTPUTS), "Reaches 2 screens in Green room and Stage.", "a screen in both is counted once");
    assert.equal(reachLine([EVERYONE], false, GROUPS, OUTPUTS), "Reaches every screen.");
    assert.equal(reachLine([GREEN], true, GROUPS, OUTPUTS), "Takes over 2 screens in Green room for 30 seconds.");
    assert.equal(reachLine([EVERYONE], true, GROUPS, OUTPUTS), "Takes over every screen for 30 seconds.");
    assert.equal(reachLine([STAGE], false, GROUPS, [{ groups: [] }]), "No screens are in Stage yet.");
    assert.equal(ALERT_MS / 1000, 30, "the hint says the alert length the server uses");
  });
});

describe("composing", () => {
  test("a quick message fills the box and sends nothing", async () => {
    const c = mount();
    await press(button(c, "2 minutes"));
    assert.equal(box(c).value, "2 minutes");
    assert.equal(posts().length, 0);
  });

  test("Alert flips Send to a red Send alert, and the hint to what an alert does", async () => {
    const c = mount();
    await press(button(c, "Green room"));
    assert.ok(button(c, "Send") && !button(c, "Send alert"));
    await press(c.querySelector('[role="switch"]') as HTMLElement);
    assert.ok(button(c, "Send alert") && !button(c, "Send"));
    assert.ok(text(c).includes("Takes over 2 screens in Green room for 30 seconds."), text(c));
    assert.equal((c.querySelector('[role="switch"]') as HTMLElement).getAttribute("aria-checked"), "true");
  });

  test("Send waits for a target and some text", async () => {
    const c = mount();
    assert.equal(button(c, "Send")!.disabled, true);
    await type(c, "Walk now");
    assert.equal(button(c, "Send")!.disabled, true, "sent with nobody to send it to");
    await press(button(c, "Stage"));
    assert.equal(button(c, "Send")!.disabled, false);
    await type(c, "   ");
    assert.equal(button(c, "Send")!.disabled, true, "sent a message of nothing but spaces");
  });

  test("sends the targets, the trimmed text, the alert flag and who it is from; then clears the text and the alert and keeps the targets", async () => {
    const c = mount({ from: "Green room iPad" });
    await press(button(c, "Green room"));
    await press(button(c, "Stage"));
    await type(c, "  Host: walk now  ");
    await press(c.querySelector('[role="switch"]') as HTMLElement);
    await press(button(c, "Send alert"));
    assert.deepEqual(posts().map((r) => [r.url, r.body]), [
      ["/api/messages", { to: [GREEN, STAGE], text: "Host: walk now", alert: true, from: "Green room iPad" }],
    ]);
    assert.equal(box(c).value, "");
    assert.ok(button(c, "Send"), "the alert switch stayed on after a send");
    assert.deepEqual(["Green room", "Stage"].map((n) => pressed(c, n)), ["true", "true"], "the targets were cleared");
  });

  test("a failed send keeps the text, the targets and the alert switch, and says why on /log", async () => {
    failWith = { status: 400, error: "no group has the id g-00000009" };
    const quiet = console.warn;
    console.warn = () => {};
    try {
      const c = mount();
      await press(button(c, "Stage"));
      await type(c, "Walk now");
      await press(c.querySelector('[role="switch"]') as HTMLElement);
      await press(button(c, "Send alert"));
      assert.equal(box(c).value, "Walk now", "the typed text was dropped on a failed send");
      assert.equal(pressed(c, "Stage"), "true");
      assert.ok(button(c, "Send alert"), "the alert switch was reset on a failed send");
      assert.equal(button(c, "Send alert")!.disabled, false, "stuck sending after a failure");
    } finally {
      console.warn = quiet;
    }
    const logged = requests.find((r) => r.url === "/api/log/client");
    assert.ok(logged, "the failure never reached /log");
    assert.equal(logged!.body!.tag, "messages");
    assert.match(String(logged!.body!.message), /could not send that message \(to g-00000002\): no group has the id/);
  });

  test("on a wall display it draws and does nothing: nothing can be picked, typed or sent", async () => {
    const c = mount({ interactive: false, state: stateOf([msg(7, { alert: true, alertUntil: NOW + 10_000 })]) });
    await press(button(c, "Stage"));
    await press(button(c, "2 minutes"));
    await press(c.querySelector('[role="switch"]') as HTMLElement);
    await type(c, "Walk now");
    assert.equal(pressed(c, "Stage"), "false", "a chip took a press on a wall");
    assert.equal(box(c).value, "", "the box took text on a wall");
    assert.ok(button(c, "Send") && !button(c, "Send alert"), "the alert switch took a press on a wall");
    assert.equal(button(c, "Send")!.disabled, true);
    assert.equal(posts().length, 0);
    // The root stops a real press landing at all.
    assert.equal((c.firstElementChild as HTMLElement).style.pointerEvents, "none");
  });

  test("the quick messages heading and grid are left out when there are none", () => {
    assert.ok(!text(mount({ state: stateOf([], []) })).includes("Quick messages"));
    assert.ok(text(mount()).includes("Quick messages"));
  });

  test("before the channel answers it claims nothing, and a failed read is said", () => {
    assert.ok(text(mount({ state: null, known: false })).includes("Reading the messages"));
    assert.ok(text(mount({ state: null, known: true })).includes("Could not read the messages"));
  });
});

describe("the thread", () => {
  test("is newest first, with each reply under its message and its sender, and a deleted group named as one", () => {
    const c = mount({
      state: stateOf([
        msg(1, { text: "first", replies: [{ id: "r1", at: NOW - 30_000, from: "Booth console", text: "Copy" }] }),
        msg(2, { text: "second", to: ["g-deadbeef"] }),
        msg(3, { text: "third", to: [EVERYONE], alert: true, from: "Companion" }),
      ]),
    });
    const t = text(c);
    assert.ok(t.indexOf("third") < t.indexOf("second") && t.indexOf("second") < t.indexOf("first"), t);
    assert.ok(t.indexOf("first") < t.indexOf("Booth console") && t.includes("Copy"), "the reply is not under its message");
    assert.ok(t.includes("(deleted group)"), t);
    assert.ok(t.includes("Companion") && t.includes("Everyone") && t.includes("alert"), t);
    assert.ok(t.includes("Producer console") && t.includes("Green room"), t);
  });

  test("an empty day says so", () => {
    assert.ok(text(mount()).includes("Nothing sent today."));
  });

  test("Clear alert is on an alert that is running by the server clock, and on nothing else", () => {
    const running = msg(1, { text: "run", alert: true, alertUntil: NOW + 10_000 });
    const ended = msg(2, { text: "ended", alert: true, alertUntil: NOW - 1 });
    const cleared = msg(3, { text: "cleared", alert: true, alertUntil: NOW + 10_000, clearedAt: NOW - 1000 });
    const plain = msg(4, { text: "plain" });
    const c = mount({ state: stateOf([running, ended, cleared, plain]) });
    const clears = [...c.querySelectorAll("button")].filter((b) => b.textContent === "Clear alert");
    assert.equal(clears.length, 1, "Clear alert on something that is not a running alert");
    // The same message, a server clock ten seconds later: the alert is over, so the button goes.
    const later = mount({ state: stateOf([running]), now: NOW + 10_001 });
    assert.ok(!button(later, "Clear alert"), "Clear alert stayed after alertUntil on the server clock");
    // And not on a wall.
    assert.ok(!button(mount({ state: stateOf([running]), interactive: false }), "Clear alert"));
  });

  test("pressing Clear alert asks the server to end that message's alert, signed", async () => {
    const running = msg(7, { alert: true, alertUntil: NOW + 10_000 });
    const c = mount({ state: stateOf([msg(1), running]) });
    await press(button(c, "Clear alert"));
    assert.deepEqual(posts().map((r) => [r.url, r.body]), [[`/api/messages/${running.id}/clear-alert`, { from: "Booth console" }]]);
  });

  test("a failed Clear alert is told and logged, and the button stays", async () => {
    failWith = { status: 500, error: "could not save" };
    const quiet = console.warn;
    console.warn = () => {};
    try {
      const running = msg(7, { alert: true, alertUntil: NOW + 10_000 });
      const c = mount({ state: stateOf([running]) });
      await press(button(c, "Clear alert"));
      assert.ok(button(c, "Clear alert") && !button(c, "Clear alert")!.disabled);
    } finally {
      console.warn = quiet;
    }
    const logged = requests.find((r) => r.url === "/api/log/client");
    assert.match(String(logged?.body?.message), /could not clear that alert \(/);
  });
});

describe("who it signs as", () => {
  const outputs = [{ id: "panel-1", name: "Booth panel" }];
  const views = [{ id: "console-1", name: "Green room iPad" }];

  test("the screen's name on a screen, the console's on a console, Home on Home", () => {
    assert.equal(senderName({ home: false, outputId: "panel-1", embedChain: ["console-1"], outputs, views }), "Booth panel");
    assert.equal(senderName({ home: false, outputId: null, embedChain: ["console-1"], outputs, views }), "Green room iPad");
    assert.equal(senderName({ home: true, outputId: null, embedChain: ["home"], outputs, views }), "Home");
  });

  test("falls back to the server's default rather than sending a blank, and cuts a long name to the limit", () => {
    assert.equal(senderName({ home: false, outputId: "gone", embedChain: ["gone"], outputs, views }), "Operator");
    assert.equal(senderName({ home: false, outputId: null, embedChain: [], outputs, views }), "Operator");
    const long = senderName({ home: false, outputId: "x", embedChain: [], outputs: [{ id: "x", name: "n".repeat(80) }], views });
    assert.equal(long.length, 60);
  });
});
