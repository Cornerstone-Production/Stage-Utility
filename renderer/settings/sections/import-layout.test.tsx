// The import review, when the file is a plan export.
//
// What is under test is the two decisions the review screen makes on the
// operator's behalf and then posts: which service type the boards land under,
// and what happens where the file and this machine both have something. A
// picker that defaults to the wrong type silently re-keys somebody's boards.
//
// NOT unit-tested here, and driven in a real browser against a real server
// instead: the drag-and-drop path onto the Import button, and how the review
// and report sheets look — jsdom loads no stylesheet, so nothing about the
// segmented control's pressed fill or the warn dot is observable at all.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND, and every absence is
// asserted as `!node`. node:assert builds its failure message by inspecting
// `actual`, and inspecting a live jsdom element does not terminate in any useful
// time: a sibling file ran 81.5 s and was killed with no assertion text at all.

import assert from "node:assert/strict";
import { describe, test, after, afterEach } from "node:test";
import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = await import("react");

afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

// The report sheet's rebind list calls useRouter for its "Open editor" link, so
// the component needs a router in context even when the list is empty. A real
// RouterContextProvider around a router with one root route: a route TREE would
// be the test harness testing itself, and node:test's module mocking needs a
// flag the project's suite command does not pass.
const { RouterContextProvider, createRouter, createRootRoute, createMemoryHistory } =
  await import("@tanstack/react-router");
const testRouter = createRouter({
  routeTree: createRootRoute({}),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const { ImportLayout } = await import("./import-layout.js");

const TYPES = [
  { id: "st-here", name: "Sunday AM", itemTypeColors: [] },
  { id: "st-other", name: "Youth", itemTypeColors: [] },
];

function planFile(over: Record<string, unknown> = {}, sideOver: Record<string, unknown> = {}) {
  return {
    kind: "stage-utility-view", version: 1, appVersion: "1.16.0",
    createdAt: "2026-09-08T00:00:00.000Z", source: { server: "Main Campus" },
    plan: { serviceTypeId: "st-here", serviceTypeName: "Sunday AM", slotsScope: "type" },
    roots: ["v1"],
    views: [{ id: "v1", name: "Mic Board", kind: "slots", createdAt: 0, layout: null }],
    sideData: {
      slots: { v1: { "st-here": [{ id: "r1" }, { id: "r2" }] } },
      notes: {}, scriptviewLayouts: [],
      ...sideOver,
    },
    targets: { osc: [], rosstalk: [] },
    images: {},
    ...over,
  };
}

/** What the Confirm button posted, and the render handle. */
function mount(file: unknown) {
  const posted: Record<string, unknown>[] = [];
  const before = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    posted.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
    return {
      ok: true, status: 200,
      json: async () => ({
        views: [{ id: "v-new", name: "Mic Board" }],
        targetsAdded: [], targetsKept: [], images: { written: 0, shared: 0, failed: [] },
        skipped: [], rebind: [],
        plan: { serviceTypeId: "st-other", serviceTypeName: "Sunday AM", retypedFrom: "st-here" },
        slotBoards: 1, slotRows: 2,
        patchVariants: [{ sheetName: "Analog", variantName: "Sunday rig", outcome: "added" }],
        presets: { added: 1, kept: 0, replaced: 0 },
      }),
    };
  }) as unknown as typeof fetch;

  const r = render(
    React.createElement(
      RouterContextProvider as unknown as React.FunctionComponent<Record<string, unknown>>,
      { router: testRouter },
      <ImportLayout serviceTypes={TYPES} currentServiceTypeId="st-other" />,
    ),
  );
  return {
    ...r,
    posted,
    restore: () => { globalThis.fetch = before; },
    /** Feed the review a file the way the file input does. */
    async take(): Promise<void> {
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const blob = { text: async () => JSON.stringify(file), name: "plan.json" };
      Object.defineProperty(input, "files", { value: [blob], configurable: true });
      await act(async () => { fireEvent.change(input); });
      for (let i = 0; i < 100 && !screen.queryByRole("button", { name: /^Import \d+ view/ }); i++) {
        await act(async () => { await new Promise((res) => setTimeout(res, 5)); });
      }
    },
  };
}

/**
 * The service type id the picker currently holds.
 *
 * Read off the hidden native select Radix keeps in sync, not the trigger's text:
 * in jsdom the trigger renders the placeholder and every option's text together,
 * and the ID is the thing that actually gets posted.
 *
 * Returns a STRING, never the node — see the note at the top of the file.
 */
function chosenTypeId(): string {
  return (document.querySelector("select") as HTMLSelectElement | null)?.value ?? "";
}

describe("the service type picker", () => {
  test("defaults to the id the file names when this machine has it", async () => {
    const m = mount(planFile());
    await m.take();
    assert.equal(chosenTypeId(), "st-here");
    assert.ok(!!screen.queryByText("The file's type id matches one here."));
    m.unmount();
    m.restore();
  });

  test("falls back to the machine's current type when it does not, and says so", async () => {
    // Landing under the file's own id would create a board for a service type
    // that does not exist here — invisible until a Sunday.
    const m = mount(planFile({ plan: { serviceTypeId: "st-elsewhere", serviceTypeName: "Sunday AM", slotsScope: "type" } }));
    await m.take();
    assert.equal(chosenTypeId(), "st-other");
    assert.ok(!!screen.queryByText("No type here has that id; pick one."));
    m.unmount();
    m.restore();
  });

  test("is not offered at all for a plain view export", async () => {
    const file = planFile() as Record<string, unknown>;
    delete file.plan;
    delete file.roots;
    const m = mount(file);
    await m.take();
    assert.ok(!screen.queryByText("Import as service type"));
    m.unmount();
    m.restore();
  });
});

describe("what Confirm posts", () => {
  test("the bundle, the chosen type and the clash choice", async () => {
    const m = mount(planFile({}, { presets: [{ id: "p", name: "P", slots: [] }] }));
    await m.take();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Replace mine" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Import 1 view/ })); });
    for (let i = 0; i < 100 && m.posted.length === 0; i++) {
      await act(async () => { await new Promise((res) => setTimeout(res, 5)); });
    }
    assert.equal(m.posted.length, 1);
    assert.equal(m.posted[0]!.serviceTypeId, "st-here");
    assert.equal(m.posted[0]!.onClash, "replace");
    assert.equal((m.posted[0]!.bundle as { kind: string }).kind, "stage-utility-view");
    m.unmount();
    m.restore();
  });

  test("a plain view export is posted bare, with no type or clash choice", async () => {
    // The server would ignore them, but sending them still reads as a decision
    // somebody made.
    const file = planFile() as Record<string, unknown>;
    delete file.plan;
    delete file.roots;
    const m = mount(file);
    await m.take();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Import 1 view/ })); });
    for (let i = 0; i < 100 && m.posted.length === 0; i++) {
      await act(async () => { await new Promise((res) => setTimeout(res, 5)); });
    }
    assert.equal(m.posted[0]!.kind, "stage-utility-view", "the bundle was wrapped for a file with no plan");
    assert.equal(m.posted[0]!.serviceTypeId, undefined);
    m.unmount();
    m.restore();
  });
});

describe("the clash choice", () => {
  test("is offered when the file carries presets", async () => {
    const m = mount(planFile({}, { presets: [{ id: "p", name: "P", slots: [] }] }));
    await m.take();
    assert.ok(!!screen.queryByRole("button", { name: "Keep mine where they clash" }));
    m.unmount();
    m.restore();
  });

  test("is not offered when nothing in the file can clash", async () => {
    // Slot rows never can: an imported view gets a fresh id. A control with
    // nothing to decide is a control that teaches the wrong thing.
    const m = mount(planFile());
    await m.take();
    assert.ok(!screen.queryByRole("button", { name: "Keep mine where they clash" }));
    m.unmount();
    m.restore();
  });
});

describe("the rebind list on the review", () => {
  test("covers every root, so it cannot promise less than the import does", async () => {
    // The server walks every root. A review that walked views[0] alone would
    // show a shorter list than the report that follows it.
    const obj = (id: string, channel: string) => ({
      id, x: 0, y: 0, w: 1, h: 1, z: 0, style: {},
      config: { type: "wireless-channel", channelId: channel, label: channel },
    });
    const view = (id: string, name: string, objects: unknown[]) => ({
      id, name, kind: "custom", createdAt: 0,
      layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects },
    });
    const m = mount(planFile({
      roots: ["v1", "v2"],
      views: [view("v1", "One", [obj("o1", "hh-1")]), view("v2", "Two", [obj("o2", "hh-2")])],
    }, { slots: {} }));
    await m.take();
    // queryAllByText: the channel is both the label and the value on a rebind
    // row, so it is on screen twice when it is on screen at all.
    assert.ok(screen.queryAllByText("hh-1").length > 0, "the first root's binding is missing from the review");
    assert.ok(screen.queryAllByText("hh-2").length > 0, "the second root's binding is missing from the review");
    m.unmount();
    m.restore();
  });
});

describe("the report", () => {
  test("names the type it landed under and where it was retyped from", async () => {
    const m = mount(planFile());
    await m.take();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Import 1 view/ })); });
    for (let i = 0; i < 100 && !screen.queryByText(/retyped from/); i++) {
      await act(async () => { await new Promise((res) => setTimeout(res, 5)); });
    }
    assert.ok(!!screen.queryByText("landed under st-other — retyped from st-here"));
    assert.ok(!!screen.queryByText("1 board, 2 rows"));
    assert.ok(!!screen.queryByText('"Sunday rig" on Analog'));
    assert.ok(!!screen.queryByText("1 added, 0 kept, 0 replaced"));
    m.unmount();
    m.restore();
  });
});
