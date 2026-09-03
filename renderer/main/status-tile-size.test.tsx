// A status tile is the same size as the connection tile beside it, live or not.
//
// Reported twice from a wall. First: LIVE shrank and lifted the moment the
// stream started, because its elapsed clock arrived as a third line and the
// value is sized from what the other lines leave. The fix sized every status
// tile as though the third line were always there — which made the whole
// family small, live or idle, while the integration-status tile next to them
// (caption + value, nothing else) stayed the size an operator had chosen.
// Reported again as "the only one that is correct now is REAPER ONLINE".
//
// So: two lines, always. The timecode or clock rides on the caption line,
// where it costs no height, and the value is sized exactly as the connection
// tile's is. This renders both in the same box and compares the pixels.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../test-dom.js";

const BOX_PX = 270;
const teardown = installRenderDom({ clientHeight: BOX_PX });
// The Readout measures its OWN box with offsetHeight/offsetWidth, which jsdom
// leaves at 0, so every value would size to 0px and any two tiles would "match".
// Give every element a real box, the way installRenderDom does for clientHeight.
for (const [prop, px] of [["offsetHeight", BOX_PX], ["offsetWidth", 600]] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { get: () => px, configurable: true });
}

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");
const { ObjectContent } = await import("./layout-renderer.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
afterEach(async () => { cleanup(); await settle(); });

const obj = (config: Record<string, unknown>) =>
  ({ id: config.type as string, x: 0, y: 0, w: 1, h: 1, z: 0, config }) as never;

const ctx = makeRenderCtx({
  obs: { connected: true, recording: true, streaming: false, virtualCam: false, recordTimecode: "00:12:34" } as never,
  reaper: { connected: true, recording: true, positionString: "00:05:10.250" } as never,
  resi: { connected: true, live: true, startedAt: new Date(Date.now() - 23 * 60_000 - 49_000).toISOString() } as never,
  integrations: [{ id: "reaper", connection: "connected" }] as never,
  integrationLabels: { reaper: "REAPER" },
  now: Date.now(),
});

async function valueOf(config: Record<string, unknown>) {
  let container!: HTMLElement;
  await act(async () => {
    container = render(
      React.createElement(TooltipProvider as never, null, React.createElement(ObjectContent, { o: obj(config), ctx } as never)),
    ).container;
    await settle();
  });
  // The Readout marks its value wrapper; the sized text is its first descendant
  // carrying a font-size. Reading THAT, not the largest size on the page: the
  // first version of this test took the biggest font-size it could find, which
  // in jsdom was a caption, and it stayed green with the bug reintroduced.
  const valueEl = container.querySelector<HTMLElement>("[data-readout-value] [style*='font-size']");
  assert.ok(valueEl, `no sized value rendered for ${String(config.type)}`);
  const valuePx = parseFloat(valueEl!.style.fontSize);
  assert.ok(Number.isFinite(valuePx) && valuePx > 0, `value size unreadable for ${String(config.type)}: ${valueEl!.style.fontSize}`);
  return { valuePx, text: (container.textContent ?? "").replace(/\s+/g, " ").trim(), container };
}

describe("status tiles match the connection tile", () => {
  test("recording, streaming and live tiles size their value exactly as ONLINE does", async () => {
    const online = await valueOf({ type: "integration-status", integrationId: "reaper" });
    assert.ok(online.valuePx > 0);
    const family = [
      { type: "obs-status", showTimecode: true },
      { type: "reaper-status", showPosition: true },
      { type: "stream-status", platform: "resi", showElapsed: true },
    ];
    for (const config of family) {
      const tile = await valueOf(config);
      assert.equal(
        tile.valuePx,
        online.valuePx,
        `${config.type} sizes its value at ${tile.valuePx}px against ONLINE's ${online.valuePx}px — the tiles do not match`,
      );
    }
  });

  test("the timecode or clock is on the caption line, not a line of its own", async () => {
    const obs = await valueOf({ type: "obs-status", showTimecode: true });
    assert.match(obs.text, /OBS ?00:12:34 ?Recording/i, `the timecode is not on the caption row: ${obs.text}`);
    // The Readout marks a sub-line with title={sub}; there must be none.
    assert.equal(obs.container.querySelector("[title='00:12:34']"), null, "the timecode was drawn as a third line");

    const reaper = await valueOf({ type: "reaper-status", showPosition: true });
    assert.match(reaper.text, /REAPER ?00:05:10 ?Recording/i, `the position is not on the caption row: ${reaper.text}`);
    assert.equal(reaper.container.querySelector("[title='00:05:10']"), null, "the position was drawn as a third line");
  });

  test("and a tile is the same size whether or not its reading is switched on", async () => {
    const withTc = await valueOf({ type: "obs-status", showTimecode: true });
    const without = await valueOf({ type: "obs-status", showTimecode: false });
    assert.equal(withTc.valuePx, without.valuePx, "switching the timecode on changed the size of the state word");
  });
});
