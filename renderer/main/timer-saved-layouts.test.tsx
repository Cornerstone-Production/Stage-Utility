// A layout saved with one of the four retired timers draws as a Timer from every
// store a layout reaches a screen by.
//
// The mapping is read-time (timer-config.ts) precisely because views.json is not
// the only way an object arrives: a saved layout template, a saved group and an
// imported view file each carry objects, and a migration over any one of them
// would leave the others on the old type. So this does not call the mapping. It
// saves the four old types through the REAL stores and the REAL importer, reads
// them back, and draws what comes out — asserting both that the old type
// survives the round trip untouched (nothing rewrote it) and that what is drawn
// is what the equivalent Timer draws.
//
// Delete the read in ObjectBody and every case here fails: an object of an
// unknown shape draws nothing at all.

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
import { NoStream } from "../test-fixtures/no-stream.js";

// A real data directory, never the operator's.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-timer-saved-"));
process.env.STAGE_UTILITY_DATA = dir;

const teardown = installDom();
(globalThis as { EventSource?: unknown }).EventSource = NoStream;
for (const [prop, px] of [["offsetHeight", 240], ["offsetWidth", 520]] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { get: () => px, configurable: true });
}

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");
const { viewsStore } = await import("@main/services/views-store");
const { applyViewBundle } = await import("@main/services/view-import");
const { saveLayoutTemplate, listLayoutTemplates, saveLayoutGroup, listLayoutGroups } = await import(
  "@main/services/layout-library"
);
const { layoutTemplatesStore } = await import("@main/services/layout-templates-store");
const { layoutGroupsStore } = await import("@main/services/layout-groups-store");

after(async () => {
  cleanup();
  teardown();
  await fs.rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await viewsStore.save([] as never);
  await layoutTemplatesStore.save([] as never);
  await layoutGroupsStore.save([] as never);
});
afterEach(() => cleanup());

const NOW = Date.parse("2026-10-18T15:20:41.000Z");

/** The four, as an operator's layout holds them, and the Timer each must draw as. */
const SAVED: { name: string; old: Record<string, unknown>; timer: Record<string, unknown> }[] = [
  {
    name: "PCO countdown",
    old: { type: "countdown-timer", warnSeconds: 60, caption: "Time left" },
    timer: { type: "timer", source: "service", nextItem: false, redOnOverrun: true, warnSeconds: 60, caption: "Time left" },
  },
  {
    name: "Service timer",
    old: { type: "home-live-status" },
    timer: { type: "timer", source: "service", nextItem: true, redOnOverrun: true },
  },
  {
    name: "ProPresenter timer",
    old: { type: "pp-timer", timerName: null, propresenterInstanceId: null, warnStates: true, hideWhenIdle: false, showLabel: true, caption: "Stage timer" },
    timer: { type: "timer", source: "propresenter", redOnOverrun: true, showLabel: true, caption: "Stage timer" },
  },
  {
    name: "Baptism timer",
    old: { type: "baptism-timer", field: "count", showLabel: true, caption: "Baptisms" },
    timer: { type: "timer", source: "baptism", field: "count", showLabel: true, caption: "Baptisms" },
  },
];

const pcoLive = {
  mode: "item", label: "Message", lengthSec: 60, liveStartAt: new Date(NOW - 72_000).toISOString(),
  targetAt: null, serverNow: new Date(NOW).toISOString(), nextItemTitle: "Announcements",
} as unknown as PcoLiveDTO;

/** What an object draws, as the markup it produces under live data for all four. */
function drawn(config: unknown): string {
  cleanup();
  const ctx = makeRenderCtx({
    now: NOW,
    pcoLive,
    propresenter: { connected: true, timers: [{ name: "Sermon", time: "-00:00:02", state: "overran" }] } as unknown as ProPresenterStatusDTO,
  });
  const o = { id: "o1", x: 0, y: 0, w: 0.3, h: 0.2, z: 1, config, style: {} } as never;
  const { container } = render(React.createElement(ObjectContent as never, { o, ctx }));
  return container.innerHTML.replace(/_r_[0-9a-z]+_/gi, "_id_");
}

const objectOf = (config: Record<string, unknown>, id: string) => ({ id, x: 0, y: 0, w: 0.3, h: 0.2, z: 1, config, style: {} });
const layoutOf = () => ({
  version: 1 as const,
  canvas: { width: 1920, height: 1080, background: null },
  objects: SAVED.map((s, i) => objectOf(s.old, `o${i}`)),
});

/** The guard proper: the stored object kept its old type, and draws as the Timer. */
function assertSavedDrawsAsTimer(stored: { config: unknown }[], where: string): void {
  assert.equal(stored.length, SAVED.length, `${where}: objects went missing`);
  SAVED.forEach((s, i) => {
    const config = stored[i].config as Record<string, unknown>;
    assert.equal(config.type, s.old.type, `${where}: ${s.name} was rewritten on the way through`);
    const html = drawn(config);
    assert.notEqual(html, "", `${where}: ${s.name} drew nothing`);
    assert.equal(html, drawn(s.timer), `${where}: ${s.name} does not draw as the Timer it reads as`);
  });
}

/** Each way a layout reaches a screen besides views.json: the four old types go in
 *  through the real store or importer, and the stored objects come back out. */
const STORES: { name: string; roundTrip: () => Promise<{ config: unknown }[]> }[] = [
  {
    name: "a saved layout template",
    roundTrip: async () => {
      await saveLayoutTemplate("Old stage wall", layoutOf() as never);
      return (await listLayoutTemplates())[0].layout.objects;
    },
  },
  {
    name: "a saved group",
    roundTrip: async () => {
      await saveLayoutGroup("Old timers", {
        ...objectOf({ type: "container" }, "g"),
        children: SAVED.map((s, i) => objectOf(s.old, `c${i}`)),
      } as never);
      return (await listLayoutGroups())[0].object.children ?? [];
    },
  },
  {
    name: "an imported view file",
    roundTrip: async () => {
      const report = await applyViewBundle({
        kind: "stage-utility-view", version: 1, appVersion: "1.0.0",
        createdAt: "2026-08-17T00:00:00.000Z", source: { server: "Elsewhere" },
        views: [{ id: "view-1", name: "Old stage wall", kind: "custom", createdAt: 0, layout: layoutOf() }],
        sideData: { slots: {}, notes: {}, serviceCueLayouts: [] },
        targets: { osc: [], rosstalk: [] },
        images: {},
      });
      return (await viewsStore.load()).find((v) => v.id === report.views[0].id)?.layout?.objects ?? [];
    },
  },
];

describe("a layout saved with the old timers", () => {
  for (const store of STORES) {
    test(`${store.name} keeps the old types and draws them as Timers`, async () => {
      assertSavedDrawsAsTimer(await store.roundTrip(), store.name);
    });
  }
});

describe("the harness itself", () => {
  test("the four Timers draw four different things, so equality above says something", () => {
    const markup = SAVED.map((s) => drawn(s.timer));
    assert.equal(new Set(markup).size, SAVED.length);
    assert.ok(markup.every((m) => m.length > 0));
  });
});
