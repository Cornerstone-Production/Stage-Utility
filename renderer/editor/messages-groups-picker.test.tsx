// The Groups picker in the inspector of a Messages widget: Follow this screen, or
// a list of its own. Driven through the real group hook over a stubbed fetch.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

let groups: { id: string; name: string }[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!url.startsWith("/api/messages")) throw new Error(`unexpected fetch in messages-groups-picker.test.tsx: ${url}`);
  const body = { rev: 1, groups, quickMessages: [], quickReplies: [], messages: [], alerts: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { MessagesGroupsPicker } = await import("./messages-groups-picker.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
  groups = [
    { id: "g-00000001", name: "Green room" },
    { id: "g-00000002", name: "Stage" },
    { id: "g-00000003", name: "Booth" },
  ];
});
afterEach(async () => {
  cleanup();
  await settle();
});

async function mount(own: string[] | null | undefined) {
  const changes: (string[] | null)[] = [];
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(React.createElement(MessagesGroupsPicker, { groups: own, onChange: (g: string[] | null) => changes.push(g) }));
  });
  await settle();
  return { view, changes };
}

const button = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

describe("MessagesGroupsPicker", () => {
  test("follows the screen by default, and offers no list until it is asked to", async () => {
    const { view } = await mount(null);
    assert.ok(button(view.container, "Follow this screen") && button(view.container, "Chosen groups"), "both choices are offered");
    assert.equal(view.container.querySelectorAll('[role="checkbox"]').length, 0);
  });

  test("choosing groups starts an empty list of its own, and following again clears it", async () => {
    const { view, changes } = await mount(null);
    await act(async () => { fireEvent.click(button(view.container, "Chosen groups")!); });
    assert.deepEqual(changes, [[]]);
    cleanup();
    const again = await mount(["g-00000001"]);
    await act(async () => { fireEvent.click(button(again.view.container, "Follow this screen")!); });
    assert.deepEqual(again.changes, [null]);
  });

  test("ticking a group stores the list in the config's order, not click order", async () => {
    const { view, changes } = await mount(["g-00000003"]);
    const boxes = [...view.container.querySelectorAll('[role="checkbox"]')] as HTMLElement[];
    assert.equal(boxes.length, 3, "one box per group");
    assert.deepEqual(boxes.map((b) => b.getAttribute("aria-checked")), ["false", "false", "true"]);
    await act(async () => { fireEvent.click(boxes[0]); });
    assert.deepEqual(changes, [["g-00000001", "g-00000003"]]);
  });

  test("unticking the last group leaves a list of its own, empty, rather than following the screen", async () => {
    const { view, changes } = await mount(["g-00000002"]);
    const boxes = [...view.container.querySelectorAll('[role="checkbox"]')] as HTMLElement[];
    await act(async () => { fireEvent.click(boxes[1]); });
    assert.deepEqual(changes, [[]]);
  });

  test("with no groups yet it says where to make them", async () => {
    groups = [];
    const { view } = await mount([]);
    assert.ok((view.container.textContent ?? "").includes("No groups yet"), view.container.textContent ?? "");
  });
});
