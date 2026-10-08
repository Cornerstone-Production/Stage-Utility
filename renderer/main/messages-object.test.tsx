// The Messages widget: which messages it draws, for which groups, and what it
// says when it has nothing.
//
// jsdom loads no stylesheet and reports every size as 0, so how it LOOKS (the
// proportions, the colours, the card against the mockup) is not asserted here;
// it was compared to the approved mockup in a browser. These are the decisions.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
import { EVERYONE, type MessagesState, type StageMessage } from "@main/types/messages";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { MessagesObject, ageLabel, groupNames, shownMessages } = await import("./messages-object.js");

after(() => {
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

function stateOf(messages: StageMessage[]): MessagesState {
  return { rev: 1, groups: GROUPS, quickMessages: [], quickReplies: [], messages, alerts: [] };
}

function draw(over: Partial<React.ComponentProps<typeof MessagesObject>> = {}): string {
  cleanup();
  const { container } = render(
    React.createElement(MessagesObject, {
      config: {},
      state: stateOf([]),
      known: true,
      screenGroups: [GREEN],
      editing: false,
      now: NOW,
      ts: {},
      ...over,
    }),
  );
  return container.textContent ?? "";
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
    const text = draw({ state, screenGroups: [STAGE] });
    assert.ok(text.includes("message 4") && text.includes("message 2"), text);
    assert.ok(!text.includes("message 6") && !text.includes("message 1"), text);
  });

  test("its own groups override the screen's", () => {
    const text = draw({ state, screenGroups: [STAGE], config: { groups: [GREEN] } });
    assert.ok(text.includes("message 6") && !text.includes("message 4"), text);
  });

  test("an empty list of its own is a list: only Everyone's messages", () => {
    const text = draw({ state, screenGroups: [GREEN], config: { groups: [] } });
    assert.ok(text.includes("message 3"), text);
    assert.ok(!text.includes("message 6") && !text.includes("message 5"), text);
  });
});

describe("what it says with nothing to show", () => {
  test("no messages for its groups", () => {
    assert.ok(draw({ state: stateOf([msg(1, [STAGE])]) }).includes("No messages for this screen's groups"));
  });

  test("a console with no groups of its own says to choose them in the editor, and nothing on the console", () => {
    const editor = draw({ screenGroups: null, editing: true });
    assert.ok(editor.includes("Choose groups for this widget"), editor);
    const live = draw({ screenGroups: null, editing: false });
    assert.ok(!live.includes("Choose groups") && !live.includes("No messages"), live);
    assert.ok(live.includes("Messages"), "the heading still draws");
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
