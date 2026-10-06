// The wall clock on every display view follows the app's 12h/24h setting, in the
// app's time zone.
//
// Four views drew their own clock from `getHours()`: always 12-hour, in the
// viewer's zone, whatever the operator had chosen. A venue set to 24h read
// "02:05 PM" on the ServiceCue, Dashboard, Stage display and SPL rundown screens
// and "14:05" everywhere else.
//
// The zone is pinned to one a long way from any host's (Pacific/Kiritimati,
// UTC+14), so a view that still formats in the host's zone cannot pass by
// coincidence on a machine that happens to sit there. NOTHING BELOW PASSES A DOM
// NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

/** 14:05:09 UTC, which is 04:05:09 the next day in Kiritimati. */
const NOW = Date.parse("2026-08-14T14:05:09.000Z");
const ZONE = "Pacific/Kiritimati";

let hourCycle: "12h" | "24h" = "24h";

(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  const path = String(url);
  const body = path.includes("/api/state")
    ? { hourCycle, timezone: ZONE, outputs: [], views: [], devices: [], pcoConfigured: true, serviceTypeId: "st1", planId: "p1" }
    : null;
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};
(globalThis as unknown as { EventSource: unknown }).EventSource = class {
  addEventListener() {}
  removeEventListener() {}
  close() {}
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ServiceCue } = await import("./servicecue-view.js");
const { DashboardView } = await import("./dashboard-view.js");
const { StageDisplayView } = await import("./stage-display-view.js");
const { SplRundownView } = await import("./spl-rundown-view.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
const { setDisplayHourCycle } = await import("../lib/clock-format.js");
const { TooltipProvider } = await import("../components/ui/index.js");

/** A day period right after a digit; the views put the seconds and the period in separate spans, so there is no word boundary to match. */
const DAY_PERIOD = /\d\s?[AP]M/;

const settle = () => new Promise((r) => setTimeout(r, 0));
const realNow = Date.now;

beforeEach(() => {
  Date.now = () => NOW;
});
afterEach(async () => {
  Date.now = realNow;
  cleanup();
  resetStageState();
  resetReplayCache();
  setDisplayHourCycle(null);
  await settle();
});
after(async () => {
  await settle();
  teardown();
});

const VIEWS = {
  "ServiceCue": () => React.createElement(ServiceCue, { showHeader: true }),
  "Dashboard": () => React.createElement(DashboardView, { displayId: "d1" }),
  "Stage display": () => React.createElement(StageDisplayView, { displayId: "d1" }),
  "SPL rundown": () => React.createElement(SplRundownView, { displayId: "d1" }),
} as const;

async function textOf(make: () => React.ReactElement): Promise<string> {
  await act(async () => {
    render(React.createElement(TooltipProvider, null, make()));
    for (let i = 0; i < 6; i++) await settle();
  });
  return document.body.textContent ?? "";
}

describe("a display view's clock follows the 12h/24h setting, in the app's zone", () => {
  for (const [name, make] of Object.entries(VIEWS)) {
    test(`${name} in 24h`, async () => {
      hourCycle = "24h";
      const text = await textOf(make);
      assert.match(text, /04:05/, `${name} did not draw the app zone's 24-hour time`);
      assert.doesNotMatch(text, DAY_PERIOD, `${name} drew a day period under a 24h setting`);
    });

    test(`${name} in 12h`, async () => {
      hourCycle = "12h";
      const text = await textOf(make);
      assert.match(text, /4:05/, `${name} did not draw the app zone's time`);
      assert.match(text, DAY_PERIOD, `${name} drew no day period under a 12h setting`);
    });
  }
});
