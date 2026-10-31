// The Streaming object's inspector: a Source picker on both streaming objects,
// built from STREAMER_FOR, writing the `platform` the renderer reads.
//
// Driven through the real Inspector. The Home Streaming object carried a
// `platform` the card menu could set, but the inspector only drew the picker for
// the wall `stream-status`, so on a layout the Home one had no way to choose.
//
// NOT covered: the segmented control's look. jsdom loads no stylesheet.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { settle, installRenderDom, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { Inspector } = await import("./inspector.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { STREAMER_FOR } = await import("../app/recording-status.js");
const { DEFAULT_STAGE_STATE } = await import("../main/test-render-ctx.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** Mounts the Inspector on one object and returns what it is asked to write. */
async function mount(config: Record<string, unknown>, timers = [{ name: "Stage timer", time: "00:03:00", state: "running" }, { name: "Sermon", time: "00:20:00", state: "running" }]) {
  const f = stubFetchWithLog((url) =>
    url.endsWith("/api/state") ? ok(DEFAULT_STAGE_STATE)
    : url.includes("/api/propresenter/instances")
      ? ok({
          list: [{ id: "default", name: "Main" }],
          conn: {},
          status: { default: { connected: true, timers } },
        })
      : ok({}),
  );
  const writes: LayoutObjectConfig[] = [];
  const o = { id: "t1", x: 0.1, y: 0.1, w: 0.5, h: 0.5, z: 0, config } as LayoutObject;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const noop = () => {};
  const utils = render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(Inspector, {
          o, viewId: "v1", viewName: "Test", canvas: { width: 1920, height: 1080 }, parentW: 1920, parentH: 1080, nested: false, locked: false,
          onGeom: noop, onStyle: noop, onResetLook: noop,
          onConfig: (c: LayoutObjectConfig) => writes.push(c),
          onReorder: noop, onDuplicate: noop, onRemove: noop, onReparentOut: noop, onToggleLock: noop, onSaveGroup: noop, onSnapToGrid: noop,
        }),
      ),
    ),
  );
  await settle();
  await settle();
  return { ...utils, writes, restore: f.restore };
}

describe("Streaming: Source", () => {
  for (const type of ["home-streaming", "stream-status"]) {
    test(`${type} offers every platform STREAMER_FOR names, and writes the one picked`, async () => {
      const m = await mount({ type, platform: "any" });
      try {
        const group = m.getByRole("group", { name: "Source" });
        const offered = [...group.querySelectorAll("button")].map((b) => b.textContent);
        // Exact and in the table's order, so a platform added to the table
        // reaches this picker without a second list to remember.
        assert.deepEqual(offered, Object.values(STREAMER_FOR).map((n) => n ?? "Any"));
        assert.ok(offered.includes("OBS"), "OBS is not offered");
        fireEvent.click(m.getByRole("button", { name: "OBS" }));
        assert.equal((m.writes.at(-1) as { platform?: string }).platform, "obs");
        // Not styling-only any more: it has options.
        assert.doesNotMatch(m.container.textContent ?? "", /Updates automatically/);
      } finally {
        m.restore();
      }
    });
  }
});
