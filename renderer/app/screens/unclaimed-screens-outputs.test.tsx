// The Screens page's "Not set up yet" list when a Mac running the output helper
// has been heard: one machine, one row per output, and what each row offers.
//
// Driven through the real component with a stubbed fetch, and clicked the way an
// operator clicks. Layout (the dashed card, the dimmed rows) is not asserted: jsdom
// loads no stylesheet, so that is checked in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup, screen, within, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { UnclaimedScreens } = await import("./unclaimed-screens.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const MAC = "02:aa:00:bb:11:cc";
const mac = (id: string, output: unknown, over: Record<string, unknown> = {}) => ({
  id, macs: [MAC], hostname: "booth-mini", os: "macOS 26", ip: "192.0.2.40", firstSeen: 1, lastSeen: 1, output, ...over,
});
const SDI = (n: number) => ({ kind: "decklink", name: `SDI ${n} · Card A`, port: `SDI ${n}` });
const HDMI = { kind: "display", name: "HDMI 1 · Monitor", port: "HDMI 1" };

const OUTPUTS = [
  { id: "display-1", name: "Main stage left", viewId: null, videoMode: "1080p50" },
  { id: "display-2", name: "Lobby", viewId: null },
];

const PAYLOAD = {
  scanning: true,
  seen: [
    mac("m.sdi-3", SDI(3)),
    mac("m.sdi-2", SDI(2)),
    mac("m.hdmi-1", HDMI, { screen: { w: 1920, h: 1080, mode: "1920x1080" } }),
    // A plain device on its own MAC, which keeps the list it has always had.
    { id: "pi-wall", macs: ["02:00:00:00:00:77"], hostname: "wall-pi", os: "Linux", ip: "192.0.2.60", firstSeen: 1, lastSeen: 1 },
  ],
  bound: [
    { id: "m.sdi-1", outputId: "display-1", macs: [MAC], hostname: "booth-mini", output: SDI(1) },
  ],
  matches: {},
  health: [],
};

async function mount(payload: unknown, onSetUpNew: (d: unknown) => void = () => {}, calls: { url: string; body: string }[] = []) {
  const f = stubFetchWithLog((url, init) => {
    calls.push({ url, body: String(init?.body ?? "") });
    return ok(url.endsWith("/api/devices") ? payload : {});
  });
  render(React.createElement(UnclaimedScreens, { outputs: OUTPUTS as never, onSetUpNew }));
  await act(async () => { await settle(); await settle(); });
  return f;
}

test("a Mac's outputs are one machine, said once, not one look-alike row each", async () => {
  const f = await mount(PAYLOAD);
  try {
    assert.equal(screen.getAllByText("booth-mini").length, 1, "the Mac's name was repeated per output");
    assert.ok(screen.getByText("macOS 26 · 192.0.2.40"));
    // Every output, by its own name, displays before SDI ports.
    const names = ["HDMI 1 · Monitor", "SDI 1 · Card A", "SDI 2 · Card A", "SDI 3 · Card A"];
    const shown = [...document.querySelectorAll("b")].map((b) => b.textContent).filter((t) => names.includes(t ?? ""));
    assert.deepEqual(shown, names);
  } finally {
    f.restore();
  }
});

test("each output that is not set up offers both ways of setting it up, and a set-up one does not", async () => {
  const f = await mount(PAYLOAD);
  try {
    // Three outputs waiting, plus the plain device: four of each.
    assert.equal(screen.getAllByRole("button", { name: "Set up as a new screen" }).length, 4);
    assert.equal(screen.getAllByText("Use for an existing screen…").length, 4);
    const sdi1 = screen.getByText("SDI 1 · Card A").parentElement!.parentElement!;
    assert.equal(within(sdi1).queryByRole("button", { name: "Set up as a new screen" }) !== null, false, "it is on screen");
  } finally {
    f.restore();
  }
});

test("an output already set up says which screen, and the mode it sends", async () => {
  const f = await mount(PAYLOAD);
  try {
    assert.ok(screen.getByText(/Set up as .Main stage left. · 1080p50/), "the dimmed row did not name its screen and mode");
    assert.ok(screen.getByText("Offline"), "no page is showing it");
  } finally {
    f.restore();
  }
});

test("says what each waiting output is", async () => {
  const f = await mount(PAYLOAD);
  try {
    assert.equal(screen.getAllByText("Video output · 1080p59.94 until set").length, 2);
    assert.ok(screen.getByText("Display · 1920 × 1080"));
  } finally {
    f.restore();
  }
});

test("a device that is not an output keeps the hint, and a waiting output may carry it too", async () => {
  const f = await mount({
    ...PAYLOAD,
    bound: [...PAYLOAD.bound, { id: "mac-kiosk", outputId: "display-2", macs: [MAC], label: "Lobby box" }],
    matches: { "pi-wall": ["mac-kiosk"], "m.sdi-2": ["mac-kiosk"] },
  });
  try {
    assert.equal(screen.getAllByText("Looks like Lobby box — same MAC address.").length, 2);
  } finally {
    f.restore();
  }
});

test("setting an output up as a new screen hands over the device and the output's own name", async () => {
  const got: unknown[] = [];
  const f = await mount(PAYLOAD, (d) => got.push(d));
  try {
    const row = screen.getByText("SDI 2 · Card A").parentElement!.parentElement!;
    await act(async () => { fireEvent.click(within(row).getByRole("button", { name: "Set up as a new screen" })); await settle(); });
    assert.deepEqual(got, [{ id: "m.sdi-2", hostname: "booth-mini", ip: "192.0.2.40", name: "SDI 2 · Card A" }]);
  } finally {
    f.restore();
  }
});

test("a plain device is named for its host, as ever", async () => {
  const got: unknown[] = [];
  const f = await mount(PAYLOAD, (d) => got.push(d));
  try {
    const row = screen.getByText("wall-pi").parentElement!.parentElement!;
    await act(async () => { fireEvent.click(within(row).getByRole("button", { name: "Set up as a new screen" })); await settle(); });
    assert.deepEqual(got, [{ id: "pi-wall", hostname: "wall-pi", ip: "192.0.2.60", name: undefined }]);
  } finally {
    f.restore();
  }
});

test("using an output for an existing screen claims that output's device for that screen", async () => {
  const calls: { url: string; body: string }[] = [];
  const f = await mount(PAYLOAD, () => {}, calls);
  try {
    const row = screen.getByText("SDI 3 · Card A").parentElement!.parentElement!;
    const select = within(row).getByRole("combobox") as HTMLSelectElement;
    await act(async () => { fireEvent.change(select, { target: { value: "display-2" } }); await settle(); });
    const claim = calls.find((c) => c.url.endsWith("/api/devices/claim"));
    assert.ok(claim, "choosing a screen never reached the server");
    assert.deepEqual(JSON.parse(claim.body), { deviceId: "m.sdi-3", outputId: "display-2" });
  } finally {
    f.restore();
  }
});

test("each pair of actions is tied to the output it is for, so a screen reader can tell them apart", async () => {
  const f = await mount(PAYLOAD);
  try {
    const row = screen.getByText("SDI 2 · Card A").parentElement!.parentElement!;
    const button = within(row).getByRole("button", { name: "Set up as a new screen" });
    const titleId = button.getAttribute("aria-describedby");
    assert.ok(titleId, "the button is described by nothing");
    assert.equal(document.getElementById(titleId)?.textContent, "SDI 2 · Card A");
  } finally {
    f.restore();
  }
});
