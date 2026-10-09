// The strip under a screen's card, for a screen shown by one output of a Mac
// output helper: the Mac, the port and what it is sending, where a plain device
// says the box and its size.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup, screen, act, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { ScreenDevice } = await import("./screen-device.js");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const SDI = { kind: "decklink", name: "SDI 1 · Card A", port: "SDI 1" };
const HDMI = { kind: "display", name: "HDMI 1 · Monitor", port: "HDMI 1" };
const dev = (over: Record<string, unknown>) => ({
  id: "mac1.out-1", outputId: "display-1", macs: ["02:aa:00:bb:11:cc"], hostname: "booth-mini", ...over,
});

async function strip(bound: unknown[], videoMode?: string) {
  const calls: string[] = [];
  const f = stubFetchWithLog((url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return ok({ scanning: false, seen: [], matches: {}, bound, health: [] });
  });
  render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ScreenDevice, { outputId: "display-1", name: "Main stage left", videoMode }),
    ),
  );
  await act(async () => { await settle(); await settle(); });
  return { f, calls };
}

test("a DeckLink output reads Mac, port, and the mode it is set to", async () => {
  const { f } = await strip([dev({ output: SDI })], "1080p50");
  try {
    assert.ok(screen.getByText("booth-mini · SDI 1 · 1080p50"));
  } finally {
    f.restore();
  }
});

test("a DeckLink output with no mode chosen reads the house default", async () => {
  const { f } = await strip([dev({ output: SDI })]);
  try {
    assert.ok(screen.getByText("booth-mini · SDI 1 · 1080p59.94"));
  } finally {
    f.restore();
  }
});

test("a display reads Mac, port and the size it is driven at, and ignores a video mode", async () => {
  const { f } = await strip([dev({ output: HDMI, screen: { w: 1920, h: 1080 } })], "1080p50");
  try {
    assert.ok(screen.getByText("booth-mini · HDMI 1 · 1920 × 1080"));
  } finally {
    f.restore();
  }
});

test("a device that is not an output reads as it always did", async () => {
  const { f } = await strip([dev({ output: undefined, label: "Lobby box", screen: { w: 1280, h: 720 } })]);
  try {
    assert.ok(screen.getByText(/Lobby box/));
    assert.equal(screen.queryByText(/SDI/) !== null, false, "it is on screen");
    assert.ok(screen.getByText(/1280 × 720/));
  } finally {
    f.restore();
  }
});

test("Release from the strip unbinds the device", async () => {
  const { f, calls } = await strip([dev({ output: SDI })]);
  try {
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Release" })); await settle(); });
    assert.ok(calls.includes("POST /api/devices/release"), `no release was sent: ${calls.join(", ")}`);
  } finally {
    f.restore();
  }
});
