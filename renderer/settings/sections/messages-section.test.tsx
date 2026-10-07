// Settings -> Messages, driven through the real section against a fake server
// that does what the real one does with the body: it keeps the whole config,
// hands a group with no id one, and refuses a duplicate name.
//
// What matters here is the PUT's body, because it is the whole config every
// time: a rename that sent only the renamed group would delete the rest. And
// what an operator is told when a save fails, and that what they typed is
// still there to fix.
//
// Every name and id below is INVENTED. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { alerts, ok, reply, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent, act, within } = await import("@testing-library/react");
const React = await import("react");
const { MessagesSection } = await import("./messages-section.js");
const { TooltipProvider, ConfirmHost, Toaster } = await import("../../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const GREEN = { id: "g-11111111", name: "Green room" };
const STAGE = { id: "g-22222222", name: "Stage" };

interface Config {
  groups: { id: string; name: string }[];
  quickMessages: string[];
  quickReplies: string[];
}

let server: Config;
let puts: Config[] = [];
let refuse: string | null = null;
let readFails = false;
let fetchStub: ReturnType<typeof stubFetchWithLog>;

beforeEach(() => {
  server = {
    groups: [GREEN, STAGE],
    quickMessages: ["Walk now", "2 minutes"],
    quickReplies: ["Copy"],
  };
  puts = [];
  refuse = null;
  readFails = false;
  fetchStub = stubFetchWithLog((url, init) => {
    if (url !== "/api/messaging") return ok({});
    if ((init?.method ?? "GET") === "PUT") {
      const body = JSON.parse(String(init?.body)) as { groups: { id?: string; name: string }[]; quickMessages: string[]; quickReplies: string[] };
      puts.push(body as Config);
      if (refuse) return reply(400, { error: refuse });
      let n = 0;
      server = {
        groups: body.groups.map((g) => ({ id: g.id ?? `g-9999999${++n}`, name: g.name })),
        quickMessages: body.quickMessages,
        quickReplies: body.quickReplies,
      };
      return ok(server);
    }
    if (readFails) throw new TypeError("fetch failed");
    return ok(server);
  });
});
afterEach(() => fetchStub.restore());

const outputs = (...groups: string[][]): Output[] =>
  groups.map((g, i) => ({ id: `display-${i}`, name: `Screen ${i}`, viewId: null, groups: g }));

async function mount(screens: Output[] = []) {
  render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(MessagesSection, { outputs: screens }),
      React.createElement(ConfirmHost),
      React.createElement(Toaster),
    ),
  );
  await settle();
  await settle();
}

/** The change handler fires on React's synthetic input event. */
function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
async function flush() {
  await settle();
  await settle();
}

test("shows the groups and both lists the server holds", async () => {
  await mount();
  assert.deepEqual(
    screen.getAllByLabelText(/^Rename /).map((i) => (i as HTMLInputElement).value),
    ["Green room", "Stage"],
  );
  assert.deepEqual(
    screen.getAllByLabelText(/^Edit /).map((i) => (i as HTMLInputElement).value),
    ["Walk now", "2 minutes", "Copy"],
  );
});

test("adding a group sends the WHOLE config, the new group without an id, and shows the id the server gave it", async () => {
  await mount();
  type("New group", "Booth");
  fireEvent.click(within(screen.getByTestId("messages-groups")).getByRole("button", { name: /Add/ }));
  await flush();
  assert.deepEqual(puts, [
    {
      groups: [GREEN, STAGE, { name: "Booth" }],
      quickMessages: ["Walk now", "2 minutes"],
      quickReplies: ["Copy"],
    },
  ]);
  assert.deepEqual(
    screen.getAllByLabelText(/^Rename /).map((i) => (i as HTMLInputElement).value),
    ["Green room", "Stage", "Booth"],
  );
  assert.equal((screen.getByLabelText("New group") as HTMLInputElement).value, "", "the box clears once it saved");
});

test("renaming a group keeps its id, so the screens in it stay in it", async () => {
  await mount();
  const box = screen.getByLabelText("Rename Stage");
  fireEvent.change(box, { target: { value: "Main stage" } });
  fireEvent.blur(box);
  await flush();
  assert.deepEqual(puts[0].groups, [GREEN, { id: STAGE.id, name: "Main stage" }]);
});

test("a rename left unchanged, or emptied, sends nothing and puts the name back", async () => {
  await mount();
  const box = screen.getByLabelText("Rename Stage") as HTMLInputElement;
  fireEvent.change(box, { target: { value: "  Stage " } });
  fireEvent.blur(box);
  fireEvent.change(box, { target: { value: "   " } });
  fireEvent.blur(box);
  await flush();
  assert.equal(puts.length, 0, "something was saved");
  assert.equal(box.value, "Stage");
});

test("a refused save says why, reaches /log, and leaves what was typed where it is", async () => {
  await mount();
  refuse = 'two groups are named "Stage" (names are not case-sensitive)';
  const box = screen.getByLabelText("Rename Green room") as HTMLInputElement;
  fireEvent.change(box, { target: { value: "stage" } });
  fireEvent.blur(box);
  await flush();
  assert.equal(puts.length, 1);
  assert.match(document.body.textContent ?? "", /Couldn't save that: two groups are named "Stage"/);
  assert.equal((screen.getByLabelText("Rename Green room") as HTMLInputElement).value, "stage", "the refused name was thrown away");
  assert.ok(
    fetchStub.logs.some((l) => l.tag === "messages" && /could not save the groups and quick messages: two groups are named/.test(l.message)),
    `expected a [messages] line, got ${JSON.stringify(fetchStub.logs)}`,
  );
});

test("a group that failed to add stays in the box", async () => {
  await mount();
  refuse = "groups can hold at most 20 (this has 21)";
  type("New group", "Booth");
  fireEvent.click(within(screen.getByTestId("messages-groups")).getByRole("button", { name: /Add/ }));
  await flush();
  assert.equal((screen.getByLabelText("New group") as HTMLInputElement).value, "Booth");
});

test("removing a group asks first and says how many screens are in it", async () => {
  await mount(outputs([STAGE.id], [STAGE.id, GREEN.id], []));
  fireEvent.click(screen.getByLabelText("Remove Stage"));
  await flush();
  assert.match(document.body.textContent ?? "", /Remove Stage\?/);
  assert.match(document.body.textContent ?? "", /2 screens are in it/);
  assert.equal(puts.length, 0, "removed before anyone said yes");
});

test("a group with one screen says 'is', and one with none says so", async () => {
  await mount(outputs([GREEN.id]));
  fireEvent.click(screen.getByLabelText("Remove Green room"));
  await flush();
  assert.match(document.body.textContent ?? "", /1 screen is in it/);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await flush();
  fireEvent.click(screen.getByLabelText("Remove Stage"));
  await flush();
  assert.match(document.body.textContent ?? "", /No screens are in it/);
});

test("cancelling the removal changes nothing; confirming saves the list without it", async () => {
  await mount(outputs([STAGE.id]));
  fireEvent.click(screen.getByLabelText("Remove Stage"));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await flush();
  assert.equal(puts.length, 0, "something was saved");

  fireEvent.click(screen.getByLabelText("Remove Stage"));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await flush();
  assert.deepEqual(puts[0].groups, [GREEN]);
  assert.equal(screen.queryByLabelText("Rename Stage"), null);
});

test("adding a quick message sends the whole config with it appended", async () => {
  await mount();
  type("New quick message", "Wrap it up");
  fireEvent.click(within(screen.getByTestId("messages-quick-messages")).getByRole("button", { name: /Add/ }));
  await flush();
  assert.deepEqual(puts, [
    { groups: [GREEN, STAGE], quickMessages: ["Walk now", "2 minutes", "Wrap it up"], quickReplies: ["Copy"] },
  ]);
});

test("editing a quick reply saves it trimmed, in place", async () => {
  await mount();
  const box = screen.getByLabelText("Edit Copy");
  fireEvent.change(box, { target: { value: "  Got it " } });
  fireEvent.blur(box);
  await flush();
  assert.deepEqual(puts[0].quickReplies, ["Got it"]);
});

test("an emptied quick message is put back, not saved: removing is the trash can", async () => {
  await mount();
  const box = screen.getByLabelText("Edit Walk now") as HTMLInputElement;
  fireEvent.change(box, { target: { value: "   " } });
  fireEvent.blur(box);
  await flush();
  assert.equal(puts.length, 0, "an empty quick message was sent to the server");
  assert.equal(box.value, "Walk now");
});

test("a quick message left as it was sends nothing", async () => {
  await mount();
  const box = screen.getByLabelText("Edit Walk now");
  fireEvent.change(box, { target: { value: " Walk now " } });
  fireEvent.blur(box);
  await flush();
  assert.equal(puts.length, 0);
});

test("removing a quick message needs no confirmation and saves the list without it", async () => {
  await mount();
  fireEvent.click(screen.getByLabelText("Remove Walk now"));
  await flush();
  assert.deepEqual(puts[0].quickMessages, ["2 minutes"]);
});

test("moving a quick message changes the order consoles offer, and the ends cannot move past themselves", async () => {
  await mount();
  assert.equal((screen.getByLabelText("Move Walk now up") as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByLabelText("Move 2 minutes down") as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByLabelText("Move 2 minutes up"));
  await flush();
  assert.deepEqual(puts[0].quickMessages, ["2 minutes", "Walk now"]);
  assert.deepEqual(
    within(screen.getByTestId("messages-quick-messages")).getAllByLabelText(/^Edit /).map((i) => (i as HTMLInputElement).value),
    ["2 minutes", "Walk now"],
    "the list on screen did not follow the save",
  );
});

test("the lists stop at their limits: 24 quick messages, 12 quick replies, 20 groups", async () => {
  server = {
    groups: Array.from({ length: 20 }, (_, i) => ({ id: `g-${i.toString(16).padStart(8, "0")}`, name: `G${i}` })),
    quickMessages: Array.from({ length: 24 }, (_, i) => `m${i}`),
    quickReplies: Array.from({ length: 12 }, (_, i) => `r${i}`),
  };
  await mount();
  assert.equal((screen.getByLabelText("New group") as HTMLInputElement).disabled, true);
  assert.equal((screen.getByLabelText("New quick message") as HTMLInputElement).disabled, true);
  assert.equal((screen.getByLabelText("New quick reply") as HTMLInputElement).disabled, true);
  assert.ok(screen.getByText("24 of 24"));
  assert.ok(screen.getByText("12 of 12"));
  assert.ok(screen.getByText("20 of 20"));
});

test("a read that failed says so, offers no editor, and never claims there are no groups", async () => {
  readFails = true;
  await mount();
  assert.match(alerts(), /Couldn't load the groups and quick messages/);
  assert.equal(screen.queryByText(/No groups yet/), null);
  assert.equal(screen.queryByLabelText("New group"), null, "an editor over a list nobody could read would save over it");
  assert.ok(fetchStub.logs.some((l) => l.tag === "messages" && /could not read the groups and quick messages/.test(l.message)));
});

test("Try again reads it again, and the editor appears", async () => {
  readFails = true;
  await mount();
  readFails = false;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  await flush();
  assert.ok(screen.getByLabelText("New group"));
  assert.equal(alerts(), "");
});

test("an empty config says none yet rather than drawing nothing", async () => {
  server = { groups: [], quickMessages: [], quickReplies: [] };
  await mount();
  assert.ok(screen.getByText("No groups yet."));
  assert.equal(screen.getAllByText("None yet.").length, 2);
});
