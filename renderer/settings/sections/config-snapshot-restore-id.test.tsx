// The restore dialog asks about the server id, and sends the answer.
//
// A config carries the id of the server it was saved on; screens bind to it.
// Restoring it onto a second box that keeps running must not take that id, so the
// dialog asks, unticked, whenever the config's id is not this server's. The
// answer only matters if it reaches the server: these drive the real panel, read
// the request body it sent, and check the dialog stays as it was when there is
// nothing to ask.
//
// Nothing below passes a DOM node to assert: every query is coerced first (see
// advanced-section-writes.test.tsx for why).

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";
import type { SectionHandlers } from "../types.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent, within } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AdvancedSection } = await import("./advanced-section.js");
const { TooltipProvider, Toaster } = await import("../../components/ui/index.js");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

const OWN = "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3";
const OTHER = "7c1e04ab-92f3-4d6a-b1e8-0f5c3a9d2e64";

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});

/** Every restore request the panel sent: the path and its JSON body. */
let restores: { url: string; body: Record<string, unknown> }[] = [];
let fetchStub: { restore: () => void } | null = null;

/** How many screens /api/devices says are set up here. */
let boundHere = 0;

function stubFetch(snapshotServerId: string | null, opts: { bound?: number; snapshotCarriesBindings?: boolean } = {}) {
  restores = [];
  boundHere = opts.bound ?? 0;
  fetchStub = stubFetchWithLog((url, init) => {
    if (url.includes("/api/config/import") || url.includes("/recall")) {
      restores.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return ok({ ok: true, applied: [], restarting: true });
    }
    if (url.includes("/api/config/snapshots")) {
      return ok([{
        id: "snap-1", name: "Sunday AM", createdAt: "2026-11-08T07:42:00.000Z", appVersion: "1.28.2", fileCount: 31,
        serverId: snapshotServerId, carriesScreens: true, carriesBindings: opts.snapshotCarriesBindings ?? true,
      }]);
    }
    if (url.includes("/api/devices")) {
      return ok({ scanning: false, bound: Array.from({ length: boundHere }, (_, i) => ({ id: `pi-${i}` })), seen: [] });
    }
    if (url.includes("/api/update/status")) return ok(null);
    if (url.includes("/api/update/lock")) return ok({ active: false, reasons: [] });
    if (url.includes("/api/backup/schedule")) return ok(null);
    return ok([]);
  });
}

beforeEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

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
          tab: "data",
          stageState: { kioskDiscovery: true, serverIdentity: { id: OWN } } as unknown as StageState,
          updateStatus: null,
          handlers: {} as unknown as SectionHandlers,
        }),
        React.createElement(ConfirmHost),
        React.createElement(Toaster),
      ),
    ),
  );
}

/** Pick a config file in the hidden input, as Upload & restore does. */
async function upload(serverId: string | null, opts: { bindings?: boolean } = {}) {
  const settings = serverId ? { appName: "There", serverId } : { appName: "There" };
  const files: Record<string, unknown> = { "settings.json": settings };
  if (opts.bindings) files["kiosk-devices.json"] = [{ id: "pi-theirs", token: "", outputId: "display-2", macs: [] }];
  const json = JSON.stringify({ kind: "stage-utility-config", version: 1, files });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([json], "stage-utility-config-2026-11-08.json", { type: "application/json" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
  return screen.findByRole("alertdialog");
}

const hasCheckbox = (dialog: HTMLElement) => within(dialog).queryAllByRole("checkbox").length > 0;
const dialogText = (dialog: HTMLElement) => (dialog.textContent ?? "").replace(/\s+/g, " ");

describe("Upload & restore", () => {
  test("a config from another server asks, unticked, and sends replacesOriginal: false", async () => {
    stubFetch(null);
    mount();
    await settle();
    const dialog = await upload(OTHER);
    assert.equal(hasCheckbox(dialog), true, "no question was asked about another server's id");
    assert.match(dialogText(dialog), /This config was saved on another server\./);
    assert.match(dialogText(dialog), /Use the config's server id/);
    assert.equal(within(dialog).getByRole("checkbox").getAttribute("aria-checked"), "false");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    await eventually(() => assert.equal(restores.length, 1));
    assert.equal(restores[0].body.replacesOriginal, false);
  });

  test("ticked, it says so on the button and sends replacesOriginal: true", async () => {
    stubFetch(null);
    mount();
    await settle();
    const dialog = await upload(OTHER);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore as replacement" }));
    await eventually(() => assert.equal(restores.length, 1));
    assert.equal(restores[0].body.replacesOriginal, true);
  });

  test("this server's own config asks nothing", async () => {
    stubFetch(null);
    mount();
    await settle();
    const dialog = await upload(OWN);
    assert.equal(hasCheckbox(dialog), false);
    assert.doesNotMatch(dialogText(dialog), /another server/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    await eventually(() => assert.equal(restores.length, 1));
    assert.notEqual(restores[0].body.replacesOriginal, true);
  });

  test("a config with no server id asks nothing", async () => {
    stubFetch(null);
    mount();
    await settle();
    const dialog = await upload(null);
    assert.equal(hasCheckbox(dialog), false);
  });
});

describe("Recall", () => {
  test("a snapshot saved under another server's id asks, and sends the answer", async () => {
    stubFetch(OTHER);
    mount();
    await settle();
    fireEvent.click(await eventually(() => screen.getByRole("button", { name: /Recall/ })));
    const dialog = await screen.findByRole("alertdialog");
    assert.equal(hasCheckbox(dialog), true);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Recall as replacement" }));
    await eventually(() => assert.equal(restores.length, 1));
    assert.match(restores[0].url, /\/api\/config\/snapshots\/snap-1\/recall$/);
    assert.equal(restores[0].body.replacesOriginal, true);
  });

  test("a snapshot saved on this server asks nothing", async () => {
    stubFetch(OWN);
    mount();
    await settle();
    fireEvent.click(await eventually(() => screen.getByRole("button", { name: /Recall/ })));
    const dialog = await screen.findByRole("alertdialog");
    assert.equal(hasCheckbox(dialog), false);
    assert.equal(dialogText(dialog).includes("Recall \"Sunday AM\"?"), true);
  });
});

describe("the release line: said exactly when this server's screens will be released", () => {
  const LINE = /Screens set up on this server will be released and need setting up again\./;

  test("ANOTHER SERVER'S CONFIG, UNTICKED, releases: said; ticked, its bindings replace these: not said", async () => {
    stubFetch(null, { bound: 1 });
    mount();
    await settle();
    const dialog = await upload(OTHER, { bindings: true });
    await eventually(() => assert.match(dialogText(dialog), LINE));
    fireEvent.click(within(dialog).getByRole("checkbox"));
    await settle();
    assert.doesNotMatch(dialogText(dialog), LINE);
  });

  test("ticked, from a server that set up no screens: still released, still said", async () => {
    stubFetch(null, { bound: 1 });
    mount();
    await settle();
    const dialog = await upload(OTHER);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    await settle();
    assert.match(dialogText(dialog), LINE);
  });

  test("A CONFIG WITH NO SERVER ID asks nothing, but says the release", async () => {
    stubFetch(null, { bound: 2 });
    mount();
    await settle();
    const dialog = await upload(null);
    assert.equal(hasCheckbox(dialog), false);
    assert.match(dialogText(dialog), LINE);
  });

  test("no screens set up here: nothing to release, nothing said", async () => {
    stubFetch(null, { bound: 0 });
    mount();
    await settle();
    const dialog = await upload(null);
    assert.doesNotMatch(dialogText(dialog), LINE);
  });

  test("this server's own config: nothing released, nothing said", async () => {
    stubFetch(null, { bound: 2 });
    mount();
    await settle();
    const dialog = await upload(OWN);
    assert.doesNotMatch(dialogText(dialog), LINE);
  });

  test("recall of another server's snapshot with no bindings, ticked: said", async () => {
    stubFetch(OTHER, { bound: 1, snapshotCarriesBindings: false });
    mount();
    await settle();
    fireEvent.click(await eventually(() => screen.getByRole("button", { name: /Recall/ })));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    await settle();
    assert.match(dialogText(dialog), LINE);
  });
});
