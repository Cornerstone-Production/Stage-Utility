// servicecue-layout-names.test.tsx — the layouts editor and a layout's name.
//
// A rename used to save on every keystroke, so a half-typed name was the layout's name
// for as long as it took to finish; a refused one left the page holding a name the
// server did not; and a delete said nothing of the screens that would fall back to
// All columns. Driven through the real section with a stubbed fetch. NOTHING BELOW
// PASSES A DOM NODE AS AN ASSERT OPERAND (see servicecue-section-reads.test.tsx).

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const React = await import("react");
const { ServiceCueSection } = await import("./servicecue-section.js");
const { freeLayoutName } = await import("./servicecue-layout-names.js");
const { deleteLayoutBody, plainText } = await import("./servicecue-layouts-model.js");
const { TooltipProvider, ConfirmHost } = await import("../../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const LAYOUTS = [
  { id: "svl1", name: "Audio", slug: "audio", order: 0, columnRoles: [] },
  { id: "svl2", name: "Video", slug: "video", order: 1, columnRoles: [] },
];
const VIEWS = [
  { id: "v1", name: "Booth tablet", kind: "script", serviceCueLayoutId: "svl1" },
  { id: "v2", name: "Green room", kind: "script", serviceCueLayoutId: "svl1" },
  { id: "v3", name: "Lobby", kind: "script", serviceCueLayoutId: null },
  // Changed to a slots view since: it keeps the id, and draws no layout.
  { id: "v4", name: "Stage left", kind: "slots", serviceCueLayoutId: "svl1" },
];

/** `refuse` answers a save with 400 and that reason. */
function stubFetch(opts: { refuse?: string; views?: unknown[] } = {}) {
  const posts: { layouts: { id: string; name: string }[] }[] = [];
  const f = stubFetchWithLog((url, init) => {
    if (init?.method === "POST" && url.includes("/api/servicecue/layouts")) {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return opts.refuse ? reply(400, { error: opts.refuse }) : ok(body.layouts);
    }
    if (url.includes("/api/state")) return ok({ pcoConfigured: false, views: opts.views ?? VIEWS });
    if (url.includes("/api/servicecue/layouts")) return ok(LAYOUTS);
    if (url.includes("/api/servicecue/config")) return ok({ serviceTypeIds: [] });
    if (url.includes("/api/servicecue/roles")) return ok([]);
    return ok({});
  });
  return { ...f, posts };
}

async function mount(): Promise<void> {
  render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
      React.createElement(TooltipProvider, null, React.createElement(ServiceCueSection), React.createElement(ConfirmHost)),
    ),
  );
  for (let i = 0; i < 4; i++) await settle();
}

/** Open a layout's card; its name field and its Delete are in the open card only. */
async function openCard(name: string): Promise<void> {
  fireEvent.click(await eventually(() => screen.getByRole("button", { name: new RegExp(`^${name},`) })));
  await settle();
}

/** Move a layout one place down by keyboard, as an operator would: its grip, Space, ArrowDown, Space. */
function moveDown(name: string): void {
  const grip = screen.getByRole("button", { name: `Move the ${name} layout. Press Space to pick up` });
  grip.focus();
  for (const key of [" ", "ArrowDown", " "]) fireEvent.keyDown(grip, { key });
}
const nameBox = (name: string) => screen.getByDisplayValue(name) as HTMLInputElement;

test("typing a name saves nothing until the field is left", async () => {
  const f = stubFetch();
  try {
    await mount();
    await openCard("Audio");
    const box = nameBox("Audio");
    for (const v of ["A", "Au", "Audio Cr", "Audio Crew"]) fireEvent.change(box, { target: { value: v } });
    await settle();
    assert.equal(f.posts.length, 0, "a half-typed name was saved");
    fireEvent.blur(box);
    await eventually(() => assert.equal(f.posts.length, 1));
    assert.deepEqual(f.posts[0].layouts.map((l) => l.name), ["Audio Crew", "Video"]);
  } finally {
    f.restore();
  }
});

test("Enter saves it, and Escape puts the old name back without saving", async () => {
  const f = stubFetch();
  try {
    await mount();
    await openCard("Audio");
    const box = nameBox("Audio");
    fireEvent.change(box, { target: { value: "Sound" } });
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.blur(box);
    await settle();
    assert.equal(f.posts.length, 0);
    assert.equal(box.value, "Audio");
    fireEvent.change(box, { target: { value: "Sound" } });
    box.focus(); // Enter blurs the field, which is what saves
    fireEvent.keyDown(box, { key: "Enter" });
    await eventually(() => assert.equal(f.posts.length, 1));
  } finally {
    f.restore();
  }
});

test("a name the server refuses is shown, and the old name stays", async () => {
  const f = stubFetch({ refuse: 'There is already a layout called "Video".' });
  try {
    await mount();
    await openCard("Audio");
    const box = nameBox("Audio");
    fireEvent.change(box, { target: { value: "video" } });
    fireEvent.blur(box);
    await eventually(() => assert.match(document.body.textContent ?? "", /already a layout called "Video"/));
    assert.equal(box.value, "Audio");
    // The page did not keep it either: the next save carries the old name.
    moveDown("Audio");
    await eventually(() => assert.equal(f.posts.length, 2));
    assert.deepEqual(f.posts[1].layouts.map((l) => l.name), ["Video", "Audio"], "the page kept a name the server refused");
  } finally {
    f.restore();
  }
});

test("the delete confirm names the screens that use the layout", async () => {
  const f = stubFetch();
  try {
    await mount();
    await openCard("Audio");
    fireEvent.click(screen.getByRole("button", { name: "Delete Audio" }));
    await eventually(() => assert.match(document.body.textContent ?? "", /Delete Audio\?/));
    assert.match(document.body.textContent ?? "", /Booth tablet and Green room use this layout\. They will show All columns\. A tablet opened at its address will show All columns too\./);
  } finally {
    f.restore();
  }
});

test("the delete confirm says so when no display is set to the layout", async () => {
  const f = stubFetch();
  try {
    await mount();
    await openCard("Video");
    fireEvent.click(screen.getByRole("button", { name: "Delete Video" }));
    await eventually(() => assert.match(document.body.textContent ?? "", /No screens use this layout\./));
  } finally {
    f.restore();
  }
});

test("the delete confirm claims nothing about screens before they are known", () => {
  assert.doesNotMatch(plainText(deleteLayoutBody({ id: "svl1" }, null)), /No screens use/);
  assert.equal(plainText(deleteLayoutBody({ id: "svl1" }, [{ name: "Lobby", kind: "script", serviceCueLayoutId: "svl1" }])),
    "Lobby uses this layout. It will show All columns. A tablet opened at its address will show All columns too.");
});

test("a new layout's name is free even after one in the middle was deleted", () => {
  const l = (name: string, i: number) => ({ id: String(i), name, order: i });
  assert.equal(freeLayoutName([l("Layout 1", 1), l("Layout 3", 3)]), "Layout 4");
  assert.equal(freeLayoutName([l("layout 3", 1), l("Layout 2", 2)]), "Layout 4");
  assert.equal(freeLayoutName([]), "Layout 1");
});
