// advanced-section-writes.test.tsx — the "Answer devices looking for a
// server" switch, which used to be `void invoke("stage:setKioskDiscovery",
// …)` with no `.catch`. A rejected POST reached neither the screen nor /log,
// and the switch just silently did nothing (its `checked` comes from
// `stageState.kioskDiscovery`, a prop, so it snaps back with no explanation).
//
// Driven through the real component with a stubbed fetch and a real
// QueryClientProvider — two of AdvancedSection's always-mounted panels
// (AutoBackupPanel, ConfigSnapshotPanel) read through react-query. NOTHING
// BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert inspects
// `actual` to build its failure message, and inspecting a live jsdom element
// does not finish in any useful time. Every query is coerced to a boolean or
// a string first.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";
import type { SectionHandlers } from "../types.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AdvancedSection } = await import("./advanced-section.js");
const { TooltipProvider, Toaster } = await import("../../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
/** The newest toast only, scoped to the Toast viewport (`.fixed.bottom-4.right-4`
 *  in toast.tsx) — AdvancedSection's own fields carry `.text-footnote` too, and a
 *  document-wide query picked one of those up instead of "NO TOAST". */
const lastToast = () => {
  const viewport = document.querySelector(".fixed.bottom-4.right-4");
  const all = viewport ? [...viewport.querySelectorAll(".text-footnote")] : [];
  return all.length ? text(all[all.length - 1]) : "NO TOAST";
};

/** Every read AdvancedSection's always-mounted panels issue on their own,
 *  answered inertly so only the kiosk-discovery write is under test. */
function stubFetch(kioskDiscoveryFails: boolean) {
  return stubFetchWithLog((url, init) => {
    if (url.includes("/api/kiosk-discovery")) return kioskDiscoveryFails ? reply(500, { error: "boom" }) : ok({});
    if (url.includes("/api/update/status")) return ok(null);
    if (url.includes("/api/update/lock")) return ok({ active: false, reasons: [] });
    if (url.includes("/api/backup/schedule")) return ok(null);
    if (url.includes("/api/config/snapshots")) return ok([]);
    if (url.includes("/api/service-timeline")) return ok([]);
    if (url.includes("/api/history/milestones")) return ok([]);
    if (init?.method && init.method !== "GET") return ok({});
    return ok({});
  });
}

// gcTime: 0 and retry: false, or this QueryClient's default 5-minute garbage
// collection keeps a real setTimeout alive well past this test — `node --test`
// waits for the event loop to drain, so the file hangs long after every
// assertion has already run.
function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(AdvancedSection, {
          stageState: { kioskDiscovery: false } as unknown as StageState,
          updateStatus: null,
          handlers: {} as unknown as SectionHandlers,
        }),
        React.createElement(Toaster),
      ),
    ),
  );
}

test("a failed kiosk-discovery toggle toasts, rather than doing nothing silently", async () => {
  const f = stubFetch(true);
  try {
    mount();
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("switch", { name: "Answer kiosk devices looking for a server" }));
    await settle();
    assert.match(lastToast(), /Could not change this setting/i);
  } finally {
    f.restore();
  }
});

test("control: a successful toggle does not toast", async () => {
  const f = stubFetch(false);
  try {
    mount();
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("switch", { name: "Answer kiosk devices looking for a server" }));
    await settle();
    assert.equal(lastToast(), "NO TOAST");
  } finally {
    f.restore();
  }
});
