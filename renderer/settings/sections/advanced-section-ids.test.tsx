// advanced-section-ids.test.tsx — the Advanced registry and the page it draws
// cannot drift.
//
// Renders the real AdvancedSection on every tab, with every conditional row
// switched on, and collects the `data-setting-id` of each row actually drawn. The
// sorted list of those ids must equal the list below EXACTLY, and each id must
// appear on the tab its registry entry names. A row that loses its id, a setting
// added to the registry that no card draws, and a row drawn on the wrong tab each
// fail here. The list is spelled out one id per line rather than derived from the
// registry, so adding a setting is a visible line in the diff and two branches
// adding different ones merge cleanly.
//
// Reads the DOM the component produced, not its source: a comment naming an id
// satisfies nothing.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";
import { DEFAULT_VIDEO_PORTS } from "@main/types/video";
import type { SectionHandlers } from "../types.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AdvancedSection } = await import("./advanced-section.js");
const { ADVANCED_SETTINGS, ADVANCED_TABS } = await import("./advanced-settings.js");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});

/** Every setting on the page, sorted. Add a line here when a setting joins the registry. */
const EXPECTED_IDS = [
  "auto-backups",
  "clock-format",
  "config-snapshot",
  "context-bar",
  "data-archive",
  "history-milestones",
  "host-names-enforce",
  "host-names-list",
  "kiosk-discovery",
  "kiosk-setup",
  "public-address",
  "reconnect-idle",
  "reconnect-lead",
  "reconnect-tail",
  "reconnect-wake",
  "taper-post",
  "taper-pre",
  "timezone",
  "update-machines",
  "update-mode",
  "update-status",
  "update-track",
  "update-window",
  "video-relay-ffmpeg",
  "video-relay-ports",
];

const STAGE_STATE = {
  reconnectSchedule: { enabled: true, leadMin: 120, tailMin: 60, dormantMin: 30 },
  autoUpdate: { mode: "auto-install", dayOfWeek: null, hour: 3 },
} as unknown as StageState;

// A usable updater that knows two tracks, so the track row is drawn.
const UPDATE_STATUS = {
  phase: "idle",
  canUpdate: true,
  version: "1.0.0",
  branch: "main",
  tracks: ["main", "beta"],
  behind: 0,
  lastCheckedAt: "2026-01-01T00:00:00.000Z",
} as unknown as UpdateStatus;

function stubFetch() {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/backup/schedule")) {
      return ok({ enabled: false, intervalDays: 7, keep: 5, includeArchive: false, destination: "" });
    }
    if (url.includes("/api/config/snapshots")) return ok([]);
    if (url.includes("/api/history/milestones")) return ok([]);
    // The real ports form, not the Loading placeholder: it is the form that carries the id.
    if (url.endsWith("/api/video/state")) return ok({ rev: 1, relay: { state: "off" }, kinds: [], ports: DEFAULT_VIDEO_PORTS, feeds: [] });
    return ok({});
  });
}

function mount(tab: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(AdvancedSection, {
          tab,
          stageState: STAGE_STATE,
          updateStatus: UPDATE_STATUS,
          handlers: {} as unknown as SectionHandlers,
        }),
      ),
    ),
  );
}

/** The setting ids the page is drawing, as strings. */
const idsDrawn = (root: HTMLElement) => [...root.querySelectorAll("[data-setting-id]")].map((el) => el.getAttribute("data-setting-id") ?? "");

describe("Advanced settings registry and page", () => {
  test("the ids drawn across every tab are exactly the listed ids, each on its own tab", async () => {
    const f = stubFetch();
    try {
      const found: string[] = [];
      for (const { id: tab } of ADVANCED_TABS) {
        const { container, unmount } = mount(tab);
        await settle();
        // The two data panels draw once their reads land.
        if (tab === "data") await eventually(() => assert.ok(idsDrawn(container).includes("auto-backups"), "backups never loaded"));
        // The ports card draws a Loading placeholder until the video state lands; wait it out.
        if (tab === "video") await eventually(() => assert.ok(idsDrawn(container).includes("video-relay-ports"), "the ports never loaded"));
        assert.ok(!/Loading…/.test(container.textContent ?? ""), `the ${tab} tab still shows Loading…`);
        const here = idsDrawn(container);
        for (const id of here) {
          const entry = ADVANCED_SETTINGS.find((s) => s.id === id);
          assert.equal(entry?.tab, tab, `${id} is drawn on the ${tab} tab; the registry puts it on ${entry?.tab}`);
        }
        found.push(...here);
        unmount();
        cleanup();
      }
      assert.deepEqual(found.sort(), EXPECTED_IDS);
    } finally {
      f.restore();
    }
  });

  test("the registry lists exactly those ids", () => {
    assert.deepEqual(ADVANCED_SETTINGS.map((s) => s.id).sort(), EXPECTED_IDS);
  });
});
