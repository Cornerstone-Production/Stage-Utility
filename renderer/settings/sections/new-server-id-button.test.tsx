// New server id on the Server id row: offered only while another server answers
// with this id, behind a confirm, and it really sends the request.
//
// Nothing below passes a DOM node to assert: every query is coerced first.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";
import type { SectionHandlers } from "../types.js";
import type { ServerIdentity } from "@main/types/kiosk";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent, within } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AdvancedSection } = await import("./advanced-section.js");
const { TooltipProvider, Toaster } = await import("../../components/ui/index.js");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

const OWN = "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3";
let newIdPosts = 0;
const stub = stubFetchWithLog((url, init) => {
  if (url.includes("/api/server-id/new") && init?.method === "POST") {
    newIdPosts += 1;
    return ok({});
  }
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
  newIdPosts = 0;
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
        React.createElement(ConfirmHost),
        React.createElement(Toaster),
      ),
    ),
  );
}

const button = () => screen.queryByRole("button", { name: "New server id…" });

describe("New server id", () => {
  test("is not offered while no other server answers with this id", async () => {
    mount({ id: OWN, check: { state: "ok", at: 1 }, duplicates: [] });
    await settle();
    await eventually(() => assert.ok(document.querySelector('[data-setting-id="server-id"]')));
    assert.equal(button() === null, true);
  });

  test("WHILE ONE DOES: offered, confirmed, and sent", async () => {
    mount({ id: OWN, check: { state: "ok", at: 1 }, duplicates: [{ address: "192.168.1.60", since: 1 }] });
    await settle();
    fireEvent.click(await eventually(() => {
      const b = button();
      assert.ok(b, "no New server id button while another server has this id");
      return b;
    }));
    const dialog = await screen.findByRole("alertdialog");
    const said = (dialog.textContent ?? "").replace(/\s+/g, " ");
    assert.match(said, /Give this server a new id\?/);
    assert.match(said, /The server at 192\.168\.1\.60 keeps the current id/);
    fireEvent.click(within(dialog).getByRole("button", { name: "New id" }));
    await eventually(() => assert.equal(newIdPosts, 1));
  });

  test("cancelled, sends nothing", async () => {
    mount({ id: OWN, check: { state: "ok", at: 1 }, duplicates: [{ address: "192.168.1.60", since: 1 }] });
    await settle();
    fireEvent.click(await eventually(() => button()!));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await settle();
    assert.equal(newIdPosts, 0);
  });
});
