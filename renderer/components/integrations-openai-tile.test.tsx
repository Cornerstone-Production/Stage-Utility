// OpenAI is a tile in the Integrations grid, though the server does not describe it.
//
// What is guarded: it sorts under "Not set up" while no key is saved and in the use
// grid once one is, it counts in the header the way the others do, and clicking it
// opens the key dialog through the same `?integration=` state as every other tile.
//
// NOT unit-tested here, driven in a browser instead: that the tile LOOKS like its
// neighbours (dashed border, quiet name, the icon beside the state word). jsdom loads
// no stylesheet, so a class assertion would pass on a lookalike.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, integrationCard, actIdle, settleFor } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { INTEGRATION_DESCRIPTOR_FIXTURE } = await import("../test-fixtures/integration-descriptors.js");
const { IntegrationsPanel, integrationFlashId } = await import("./integrations-panel.js");

const TOTAL = INTEGRATION_DESCRIPTOR_FIXTURE.length + 1;

type Conn = { method: "api-key" | null; hint: string | null; state: string; reason: string | null; checkedAt: string | null };
const NO_KEY: Conn = { method: null, hint: null, state: "not-connected", reason: null, checkedAt: null };
const KEYED: Conn = { method: "api-key", hint: "sk-…3f2a", state: "connected", reason: null, checkedAt: null };

let server = installFakeServer();

beforeEach(() => {
  cleanup();
  server.restore();
});
after(() =>
  unmountAndTeardown(cleanup, () => {
    server.restore();
    teardown();
  }),
);

const seen: (string | null)[] = [];
function Controlled({ initial }: { initial: string | null }) {
  const [open, setOpen] = React.useState<string | null>(initial);
  return (
    <IntegrationsPanel
      open={open}
      onOpenChange={(next) => {
        seen.push(next);
        setOpen(next);
      }}
    />
  );
}

async function panel(conn: Conn, over: Parameters<typeof installFakeServer>[0] = {}, initial: string | null = null) {
  server = installFakeServer(over, { "/api/openai": conn });
  seen.length = 0;
  const c = render(withQueryClient(<Controlled initial={initial} />));
  await actIdle();
  await integrationCard(c.container, "openai");
  return c;
}
/** Mount with /api/openai answering however `answer` says, over the fake server. A
 *  promise that never settles is a request still in flight. */
async function panelWith(answer: () => Promise<Response>, over: Parameters<typeof installFakeServer>[0] = {}) {
  server = installFakeServer(over);
  const fake = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) =>
    String(input) === "/api/openai" ? answer() : fake(input as string, init as never)) as typeof fetch;
  seen.length = 0;
  const c = render(withQueryClient(<Controlled initial={null} />));
  await settleFor(80);
  return c;
}
const failing = () =>
  Promise.resolve({ ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({ error: "boom" }) } as unknown as Response);
const pending = () => new Promise<Response>(() => {});

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');
/** The "Not set up" half, or null while nothing is in it. */
const notSetUp = (c: HTMLElement) => [...c.querySelectorAll("section")].find((s) => /Not set up/.test(s.textContent ?? "")) ?? null;

describe("placement", () => {
  test("with no key the tile is under Not set up, in the quiet treatment, with the description", async () => {
    const c = await panel(NO_KEY);
    const tile = c.container.querySelector<HTMLElement>('[data-integration-card="openai"]')!;
    assert.ok(notSetUp(c.container)?.contains(tile), "OpenAI's tile is not under the Not set up heading");
    assert.match(tile.className, /border-dashed/);
    assert.match(tile.textContent ?? "", /OpenAI/);
    assert.match(tile.textContent ?? "", /Edits mic slot photos for Theme photos on Mic slots\./);
    assert.match(tile.textContent ?? "", /Not set up/);
    assert.equal(tile.querySelector('[role="switch"]'), null, "OpenAI has nothing to switch on");
  });

  test("with a key the tile is in the use grid, showing the hint and the state, and not under Not set up", async () => {
    const c = await panel(KEYED);
    const tile = c.container.querySelector<HTMLElement>('[data-integration-card="openai"]')!;
    assert.equal(notSetUp(c.container)?.contains(tile) ?? false, false, "a saved key is still under Not set up");
    assert.doesNotMatch(tile.className, /border-dashed/);
    assert.match(tile.textContent ?? "", /sk-…3f2a/);
    assert.match(tile.textContent ?? "", /Connected/);
    assert.doesNotMatch(tile.textContent ?? "", /Not set up/);
  });

  test("a key OpenAI rejected stays up with the live ones, and says so", async () => {
    const c = await panel({ ...KEYED, state: "invalid-key" });
    const tile = c.container.querySelector<HTMLElement>('[data-integration-card="openai"]')!;
    assert.equal(notSetUp(c.container)?.contains(tile) ?? false, false);
    assert.match(tile.textContent ?? "", /Not connected/);
  });

  test("it sorts last in whichever half it is in", async () => {
    const quiet = await panel(NO_KEY);
    const dormant = [...notSetUp(quiet.container)!.querySelectorAll("[data-integration-card]")];
    assert.equal(dormant.at(-1)?.getAttribute("data-integration-card"), "openai");
    cleanup();
    const live = await panel(KEYED, { obs: { enabled: true, connection: "connected" } });
    const grid = live.container.querySelector("[data-integration-card]")!.parentElement!;
    assert.equal(grid.lastElementChild?.getAttribute("data-integration-card"), "openai");
  });
});

describe("the header count", () => {
  test("OpenAI counts in the total, and as connected only when it is", async () => {
    const connected = await panel(KEYED, { obs: { enabled: true, connection: "connected" } });
    assert.match(connected.container.textContent ?? "", new RegExp(`2 of ${TOTAL} connected`));
    cleanup();
    const rejected = await panel({ ...KEYED, state: "invalid-key" }, { obs: { enabled: true, connection: "connected" } });
    assert.match(rejected.container.textContent ?? "", new RegExp(`1 of ${TOTAL} connected`));
  });

  test("a key alone is something in use, so the count replaces the fresh-install sentence", async () => {
    const c = await panel(KEYED);
    assert.match(c.container.textContent ?? "", new RegExp(`1 of ${TOTAL} connected`));
    assert.doesNotMatch(c.container.textContent ?? "", /Nothing is set up yet/);
  });
});

describe("opening it", () => {
  test("a click asks for ?integration=openai and shows the key form in the dialog", async () => {
    const c = await panel(NO_KEY);
    fireEvent.click(c.container.querySelector('[data-integration-card="openai"]')!);
    await settleFor(60);
    assert.deepEqual(seen, ["openai"]);
    assert.match(dialog()?.textContent ?? "", /OpenAI/);
    assert.ok(dialog()?.querySelector('input[type="password"]'), "the dialog holds no key field");
  });

  test("Enter and Space open it too", async () => {
    for (const key of ["Enter", " "]) {
      const c = await panel(NO_KEY);
      fireEvent.keyDown(c.container.querySelector('[data-integration-card="openai"]')!, { key });
      await settleFor(60);
      assert.deepEqual(seen, ["openai"], `${JSON.stringify(key)} did not open it`);
      cleanup();
    }
  });

  test("a URL that names it reopens the dialog, and closing asks for null", async () => {
    await panel(NO_KEY, {}, "openai");
    await settleFor(60);
    assert.ok(dialog(), "the reload did not reopen the dialog");
    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await settleFor(60);
    assert.equal(seen.at(-1), null);
  });
});

describe("while its status is unknown", () => {
  test("a request still in flight draws the tile under Not set up, and it opens the dialog", async () => {
    const c = await panelWith(pending, { obs: { enabled: true, connection: "connected" } });
    const tile = c.container.querySelector<HTMLElement>('[data-integration-card="openai"]')!;
    assert.ok(tile, "no tile while the status loads");
    assert.ok(notSetUp(c.container)?.contains(tile), "the loading tile is not under Not set up");
    // The total counts what is drawn: the tile is on screen, so it is in M.
    assert.match(c.container.textContent ?? "", new RegExp(`1 of ${TOTAL} connected`));
    fireEvent.click(tile);
    await settleFor(60);
    assert.deepEqual(seen, ["openai"]);
    assert.ok(dialog(), "the loading tile opens no dialog");
  });

  test("a status that cannot be read keeps the tile up, says so, and the dialog shows the error", async () => {
    const c = await panelWith(failing);
    const tile = c.container.querySelector<HTMLElement>('[data-integration-card="openai"]')!;
    assert.equal(notSetUp(c.container)?.contains(tile) ?? false, false, "an unreadable status sits under Not set up");
    assert.match(tile.textContent ?? "", /Can't read status/);
    assert.match(c.container.textContent ?? "", new RegExp(`0 of ${TOTAL} connected`));
    fireEvent.click(tile);
    await settleFor(60);
    assert.match(dialog()?.textContent ?? "", /Couldn't read OpenAI's status: boom/);
  });
});

describe("the flash id", () => {
  test("the id the tile carries opens the OpenAI dialog, like a descriptor's flash id", async () => {
    const c = await panel(NO_KEY);
    assert.equal(
      c.container.querySelector('[data-integration-card="openai"]')!.getAttribute("data-flash-id"),
      integrationFlashId("openai"),
    );
    cleanup();
    await panel(NO_KEY, {}, integrationFlashId("openai"));
    await settleFor(60);
    assert.match(dialog()?.textContent ?? "", /API key/);
  });
});
