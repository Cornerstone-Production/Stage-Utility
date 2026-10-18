// The Home SPL card, drawn for real from a stubbed Smaart read: the pinned metric
// reaches the number and the caption, and a pinned metric the meter no longer
// reports is a dash naming it rather than another metric's figure.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { SplCard } = await import("./cards.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const METERS = {
  connected: true,
  apiVersion: "4",
  meters: {
    "Console::Main": { deviceName: "Console", channelName: "Main", metrics: { "SPL A Slow": 92.4, "SPL C Slow": 101.2 }, ts: null },
    "Console::Balcony": { deviceName: "Console", channelName: "Balcony", metrics: { "SPL A Slow": 78.1, "SPL C Slow": 88.6 }, ts: null },
  },
};

async function drawn(props: { meterId?: string | null; metricKey?: string | null }) {
  const f = stubFetchWithLog((url) => (url.includes("/api/spl/metrics") ? ok(METERS) : ok({})));
  try {
    const { container } = render(React.createElement(SplCard as never, props as never));
    await settle();
    let text = "";
    await eventually(() => {
      text = container.textContent ?? "";
      assert.ok(/dB|—/.test(text) && !/^SPL—$/.test(text), `the read has not landed: ${JSON.stringify(text)}`);
    });
    return text;
  } finally {
    f.restore();
  }
}

test("Automatic reads the A-weighted metric and the caption names it and the meter", async () => {
  assert.match(await drawn({}), /92 dB.*SPL A Slow · Main/);
});

test("a pinned metric is the number, and the loudest meter is judged on it", async () => {
  assert.match(await drawn({ metricKey: "SPL C Slow" }), /101 dB.*SPL C Slow · Main/);
});

test("a pinned meter and metric read that meter's metric", async () => {
  assert.match(await drawn({ meterId: "Console::Balcony", metricKey: "SPL C Slow" }), /89 dB.*SPL C Slow · Balcony/);
});

test("an empty pin is Automatic", async () => {
  assert.match(await drawn({ metricKey: "" }), /92 dB.*SPL A Slow · Main/);
});

test("a pinned metric Smaart no longer reports is a dash naming it, not another metric's number", async () => {
  const text = await drawn({ metricKey: "SPL Z Peak" });
  assert.match(text, /—.*SPL Z Peak not reporting/);
  assert.ok(!/\d+ dB/.test(text), `must not show any figure — got ${JSON.stringify(text)}`);
});
