// A muted pack must be unmistakable on the wall.
//
// The whole reason this exists is that a muted pack reports five bars and a full
// battery: the telemetry is perfect, so the ONLY thing that can say it is muted
// is the widget. A test over the driver proves the flag arrives; this proves it
// reaches the largest text on the tile rather than a qualifier nobody reads.
//
// WHAT THIS DOES NOT COVER: jsdom loads no stylesheet, so `var(--red-10)` on the
// MUTED word resolves to nothing and every measured height is 0 — the colour and
// the line-dropping the Readout composition does in a short box are not asserted
// here. Both were checked in a browser. What jsdom can answer honestly is which
// text reaches the DOM, and that the figures are not lost when it does.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

class NoStream {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

after(() => {
  cleanup();
  teardown();
});

const HEALTHY: DeviceStatus = {
  channelId: "c1::1",
  name: "Pastor",
  deviceType: "receiver",
  online: true,
  rfBars: 5,
  rfLevelDbm: -40,
  battery: 92,
  batteryMinutes: 240,
  charging: null,
  frequencyLabel: "543.125 MHz",
  audioLevel: 0.4,
  muted: false,
  quality: 5,
  interference: false,
  cycles: null,
  health: null,
  tempC: null,
  updatedAt: "2026-09-11T15:00:00.000Z",
};

function channelText(over: Partial<DeviceStatus>, show?: Record<string, boolean>): string {
  cleanup();
  const d = { ...HEALTHY, ...over };
  const ctx = makeRenderCtx({ wireless: [d] });
  const obj = {
    id: "o1",
    x: 0, y: 0, w: 0.25, h: 0.1, z: 1,
    config: {
      type: "wireless-channel",
      channelId: d.channelId,
      show: show ?? { rf: true, battery: true, frequency: true },
    },
    style: {},
  } as never;
  const { container } = render(React.createElement(ObjectContent as never, { o: obj, ctx }));
  return container.textContent ?? "";
}

function summaryText(list: Partial<DeviceStatus>[]): string {
  cleanup();
  const ctx = makeRenderCtx({ wireless: list.map((d, i) => ({ ...HEALTHY, channelId: `c1::${i + 1}`, ...d })) });
  const obj = {
    id: "o2",
    x: 0, y: 0, w: 0.25, h: 0.1, z: 1,
    config: { type: "wireless-summary", showOnline: true, showBattery: true },
    style: {},
  } as never;
  const { container } = render(React.createElement(ObjectContent as never, { o: obj, ctx }));
  return container.textContent ?? "";
}

describe("the channel tile says MUTED", () => {
  test("a muted pack is not drawn as a healthy one", () => {
    const text = channelText({ muted: true });
    assert.ok(
      text.includes("MUTED"),
      `a muted pack drew 92% and five bars and nothing else. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("and the figures it replaced are still said, not lost", () => {
    // The battery is what the headline was; muting must not hide it.
    const text = channelText({ muted: true });
    assert.ok(text.includes("92%"), `the battery vanished behind the mute. Saw: ${JSON.stringify(text)}`);
  });

  test("an unmuted pack says nothing about mute", () => {
    assert.ok(!channelText({ muted: false }).includes("MUTED"));
  });

  test("a pack that never reported mute says nothing either", () => {
    assert.ok(!channelText({ muted: null }).includes("MUTED"));
  });

  test("an OFFLINE pack is not announced as muted", () => {
    // A receiver that dropped reports a stale mute flag. "Muted" would be a lie
    // about a pack that is simply not there.
    assert.ok(!channelText({ muted: true, online: false }).includes("MUTED"));
  });
});

describe("quality and interference on the channel tile", () => {
  test("quality rides the RF toggle", () => {
    assert.ok(channelText({ quality: 3 }, { rf: true }).includes("Q3"));
  });

  test("and is absent with RF off", () => {
    assert.ok(!channelText({ quality: 3 }, { rf: false, battery: true }).includes("Q3"));
  });

  test("interference is not behind a toggle at all", () => {
    const text = channelText({ interference: true }, { battery: true });
    assert.ok(
      text.includes("RF INT"),
      `a channel being sat on said nothing. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("a clean channel says nothing about interference", () => {
    assert.ok(!channelText({ interference: false }).includes("RF INT"));
  });
});

describe("the fleet tile counts muted packs", () => {
  test("because a muted pack is ONLINE and the count cannot show it", () => {
    const text = summaryText([{ muted: true }, { muted: false }, { muted: false }]);
    assert.ok(text.includes("3/3"), `the count changed. Saw: ${JSON.stringify(text)}`);
    assert.ok(
      text.includes("1 muted"),
      `a clean 3/3 was drawn over a dead mic. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("and says nothing when none are", () => {
    assert.ok(!summaryText([{ muted: false }, { muted: null }]).includes("muted"));
  });
});
