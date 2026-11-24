// The Q-SYS card as an operator meets it: the six fields in order, a rate field
// that is a real number box with its bounds, a save that carries what is on
// screen, and the Test answer drawn in the dialog.
//
// The wording of the answer ("Connected to <design>") is the manager's, covered
// in main/services/qsys/qsys-settings-config.test.ts; here the fetch is wrapped so
// the dialog is shown the answer a real server would give.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClientAndRouter, integrationCard, settleFor, actIdle } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { IntegrationsPanel } = await import("./integrations-panel.js");

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

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[role="dialog"]')!;

async function openQsys(config: Record<string, unknown> = {}) {
  server = installFakeServer({ qsys: { config, configured: true } });
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) =>
    String(input) === "/api/integrations/qsys/test"
      ? ({ ok: true, status: 200, json: async () => ({ ok: true, message: "Connected to Lobby Design — 12 component(s)" }) } as Response)
      : real(input as string, init as RequestInit)) as typeof fetch;
  const c = render(withQueryClientAndRouter(<IntegrationsPanel />));
  await actIdle();
  fireEvent.click(await integrationCard(c.container, "qsys"));
  await settleFor(60);
  return dialog();
}

const fieldLabels = (root: HTMLElement) =>
  [...root.querySelectorAll("[data-config-field]")].map((f) => [f.getAttribute("data-config-field"), f.querySelector("input")?.getAttribute("aria-label")]);

describe("the Q-SYS dialog", () => {
  test("lists Core host, Port, User, Password and the two meter rates, in that order", async () => {
    const content = await openQsys();
    assert.deepEqual(fieldLabels(content), [
      ["host", "Core host"],
      ["port", "Port"],
      ["user", "User"],
      ["password", "Password"],
      ["volunteerMeterHz", "Volunteer meter rate"],
      ["staffMeterHz", "Staff meter rate"],
    ]);
  });

  test("the meter rates start at 10 and 20, and the box clamps to the 1-30 per second the server accepts", async () => {
    const content = await openQsys({ host: "10.0.0.5" });
    const vol = content.querySelector('[data-config-field="volunteerMeterHz"] input') as HTMLInputElement;
    const staff = content.querySelector('[data-config-field="staffMeterHz"] input') as HTMLInputElement;
    assert.equal(vol.value, "10");
    assert.equal(staff.value, "20");
    fireEvent.change(vol, { target: { value: "99" } });
    fireEvent.blur(vol);
    await settleFor(20);
    assert.equal(vol.value, "30", "a rate above 30/s was kept");
    fireEvent.change(staff, { target: { value: "0" } });
    fireEvent.blur(staff);
    await settleFor(20);
    assert.equal(staff.value, "1", "a rate below 1/s was kept");
  });

  test("Save sends the edited rate with the connection fields", async () => {
    const content = await openQsys({ host: "10.0.0.5", port: 1710 });
    fireEvent.change(content.querySelector('[data-config-field="volunteerMeterHz"] input')!, { target: { value: "15" } });
    await settleFor(20);
    fireEvent.click([...content.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!);
    await settleFor(60);
    const wrote = server.posts.filter((p) => p.path === "/api/integrations/qsys/config");
    assert.equal(wrote.length, 1);
    const sent = (wrote[0]!.body as { config: Record<string, unknown> }).config;
    assert.equal(sent.volunteerMeterHz, 15);
    assert.equal(sent.staffMeterHz, 20);
    assert.equal(sent.host, "10.0.0.5");
  });

  test("Test connection shows the answer the server gave", async () => {
    const content = await openQsys({ host: "10.0.0.5", port: 1710 });
    fireEvent.click([...content.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Test connection")!);
    await settleFor(60);
    assert.match(content.querySelector("[data-test-result]")?.textContent ?? "", /Connected to Lobby Design/);
  });
});
