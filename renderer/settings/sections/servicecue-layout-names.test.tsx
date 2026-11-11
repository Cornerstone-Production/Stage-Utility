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
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const React = await import("react");
const { ServiceCueSection } = await import("./servicecue-section.js");
const { usersMessage } = await import("./servicecue-layout-names.js");
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
  { id: "v1", name: "Booth tablet", serviceCueLayoutId: "svl1" },
  { id: "v2", name: "Green room", serviceCueLayoutId: "svl1" },
  { id: "v3", name: "Lobby", serviceCueLayoutId: null },
];

function stubFetch(opts: { views?: unknown[] } = {}) {
  const posts: { layouts: { id: string; name: string }[] }[] = [];
  const f = stubFetchWithLog((url, init) => {
    if (init?.method === "POST" && url.includes("/api/servicecue/layouts")) {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return ok(body.layouts);
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

const nameBox = (name: string) => screen.getByDisplayValue(name) as HTMLInputElement;

test("typing a name saves nothing until the field is left", async () => {
  const f = stubFetch();
  try {
    await mount();
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

test("the delete confirm names the screens that use the layout", async () => {
  const f = stubFetch();
  try {
    await mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    await eventually(() => assert.match(document.body.textContent ?? "", /Used by Booth tablet, Green room\. They will show all columns instead\./));
  } finally {
    f.restore();
  }
});

test("the delete confirm says so when no display is set to the layout", async () => {
  const f = stubFetch();
  try {
    await mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    await eventually(() => assert.match(document.body.textContent ?? "", /No display is set to it\./));
  } finally {
    f.restore();
  }
});

test("usersMessage claims nothing before the screens are known", () => {
  assert.doesNotMatch(usersMessage({ id: "svl1" }, null), /No display is set to it/);
});
