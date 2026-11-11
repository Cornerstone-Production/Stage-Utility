// The Server id row and the marks that lead to it.
//
// Another server answering with this server's id reaches the operator three ways:
// Needs attention on Home (its own source test), a red mark on the Network tab and
// the rail's Advanced row, and the alert on the row itself. Driven through the real
// AdvancedSection with stage state as the server sends it.
//
// Nothing below passes a DOM node to assert: every query is coerced first.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";
import type { SectionHandlers } from "../types.js";
import type { ServerIdentity } from "@main/types/kiosk";

const teardown = installRenderDom();

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AdvancedSection } = await import("./advanced-section.js");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { advancedSignalTab } = await import("../../app/advanced-signals.js");

const OWN = "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3";
const stub = stubFetchWithLog((url) => {
  if (url.includes("/api/update/status")) return ok(null);
  if (url.includes("/api/update/lock")) return ok({ active: false, reasons: [] });
  return ok([]);
});

after(() => {
  stub.restore();
  unmountAndTeardown(cleanup, teardown);
});
afterEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});

function mount(serverIdentity: ServerIdentity) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(AdvancedSection, {
          tab: "network",
          stageState: { kioskDiscovery: true, serverIdentity, timezone: "UTC" } as unknown as StageState,
          updateStatus: null,
          handlers: {} as unknown as SectionHandlers,
        }),
      ),
    ),
  );
}

const row = () => document.querySelector('[data-setting-id="server-id"]');
const rowText = () => (row()?.textContent ?? "").replace(/\s+/g, " ");
const networkMark = () => !!screen.getByRole("tab", { name: /Network/ }).querySelector('[data-signal="duplicate-server"]');

describe("the Server id row", () => {
  test("ANOTHER SERVER WITH THIS ID: the alert names it, and the Network tab is marked", async () => {
    mount({ id: OWN, check: { state: "ok", at: Date.UTC(2026, 10, 11, 9, 38) }, duplicates: [{ address: "192.168.1.60", since: 1 }] });
    await settle();
    await eventually(() => assert.match(rowText(), /Another server is using this id/));
    assert.match(rowText(), /The server at 192\.168\.1\.60 answers as this one/);
    assert.match(rowText(), new RegExp(OWN));
    assert.equal(networkMark(), true, "the Network tab carries no mark");
  });

  test("none heard: when the last check went out, and no mark", async () => {
    mount({ id: OWN, check: { state: "ok", at: Date.UTC(2026, 10, 11, 9, 38) }, duplicates: [] });
    await settle();
    await eventually(() => assert.match(rowText(), /No other server answered the last check, at /));
    assert.doesNotMatch(rowText(), /Another server/);
    assert.equal(networkMark(), false);
  });

  test("discovery off: not checked, said so rather than implied fine", async () => {
    mount({ id: null, check: { state: "off" }, duplicates: [] });
    await settle();
    await eventually(() => assert.match(rowText(), /Not checked: discovery is off/));
    assert.match(rowText(), /None yet/);
  });

  test("a check that could not be sent says why", async () => {
    mount({ id: OWN, check: { state: "failed", reason: "EACCES" }, duplicates: [] });
    await settle();
    await eventually(() => assert.match(rowText(), /Not checked: the check could not be sent \(EACCES\)/));
  });
});

describe("where the rail's Advanced row goes", () => {
  test("to Network while another server has this id, over an update waiting", () => {
    assert.equal(advancedSignalTab({ updateAvailable: true, hostNamesWaiting: 0, duplicateServers: 1 }), "network");
    assert.equal(advancedSignalTab({ updateAvailable: true, hostNamesWaiting: 0, duplicateServers: 0 }), "updates");
  });
});
