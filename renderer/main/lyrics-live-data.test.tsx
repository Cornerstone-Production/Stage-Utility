// Lyrics is drawn from live data on the surfaces that build their own render
// context, and opens ProPresenter's channel only while one is on screen.
//
// lyrics-render.test.tsx hands ObjectContent a context it made itself, so it can
// never see whether a surface threads `propresenterKnown` into the one it BUILDS:
// forcing it false in layout-renderer.tsx or home-grid.tsx would leave every
// Lyrics on that surface quiet for ever (the loading state) with that suite green.
// These mount the real LayoutRenderer and the real HomeGrid over a stubbed server
// that reports a status, and assert the lyric is on the screen.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";
import { NoStream } from "../test-fixtures/no-stream.js";
import { WORDS, lyricsStatus } from "../test-fixtures/lyrics-status.js";

const teardown = installRenderDom({ clientHeight: 240 });
for (const [prop, px] of [["offsetHeight", 240], ["offsetWidth", 520]] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { get: () => px, configurable: true });
}
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { LayoutRenderer } = await import("./layout-renderer.js");
const { HomeGrid } = await import("../app/home/home-grid.js");
const { DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");
const { LAYOUT_OBJECTS } = await import("./layout-objects.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const PRO = lyricsStatus();

/** Serves a status, and records every path asked for. */
function serve(status: unknown = PRO) {
  const paths: string[] = [];
  const f = stubFetchWithLog((url) => {
    const path = url.split("?")[0];
    paths.push(path);
    return path.endsWith("/api/state") ? ok(DEFAULT_STAGE_STATE)
      : path.endsWith("/api/propresenter/status") ? ok(status)
      : path.endsWith("/api/propresenter/instances") ? ok({ list: [{ id: "default", name: "Main" }], conn: {}, status: { default: status } })
      : path.endsWith("/api/integrations") ? ok({ descriptors: [], states: [{ id: "propresenter", enabled: true, configured: true, connection: "connected", message: null, config: {} }] })
      : ok(null);
  });
  return { paths, restore: f.restore };
}

const lyrics = (over: Record<string, unknown> = {}) =>
  ({ id: "a", x: 0.05, y: 0.05, w: 0.6, h: 0.6, z: 1, config: { ...LAYOUT_OBJECTS.lyrics.config(), ...over }, style: { color: "#ffffff" } }) as never;
const clock = () => ({ id: "c", x: 0.05, y: 0.05, w: 0.3, h: 0.2, z: 1, config: { type: "clock" }, style: {} }) as never;

async function draw(element: React.ReactElement): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    container = render(React.createElement(TooltipProvider as never, null, element)).container;
    await settle();
    await settle();
  });
  return container;
}

const layout = (...objects: unknown[]) => ({ version: 1, canvas: { width: 1920, height: 1080, background: null }, objects }) as never;
const asWall = (...objects: unknown[]) => React.createElement(LayoutRenderer, { layout: layout(...objects) } as never);
const asHome = (...cards: unknown[]) => React.createElement(HomeGrid, { layout: layout(...cards), cards: cards as never } as never);

describe("the real LayoutRenderer", () => {
  test("draws the lyric, its tag and the next group from the reported status", async () => {
    const s = serve();
    try {
      const c = await draw(asWall(lyrics()));
      await eventually(() => assert.ok(c.textContent?.includes("Sing it out, the night is over"), `Lyrics never drew the words: "${c.textContent}"`));
      assert.ok(c.textContent?.includes("Chorus"));
      assert.ok(c.textContent?.includes("Verse 2"), "the next group's tag");
      assert.equal(c.textContent?.includes(WORDS.verse2), false, "the next group's words, with Its lyrics off");
    } finally {
      s.restore();
    }
  });

  test("draws a dash, never a lyric, once ProPresenter says it is not connected", async () => {
    const s = serve({ ...PRO, connected: false });
    try {
      const c = await draw(asWall(lyrics()));
      await eventually(() => assert.equal(c.querySelector("[data-lyrics]")?.getAttribute("data-lyrics"), "none"));
      assert.equal(c.textContent?.includes("Sing it out"), false);
    } finally {
      s.restore();
    }
  });
});

describe("the real HomeGrid", () => {
  test("draws the lyric on a card", async () => {
    const s = serve();
    try {
      const c = await draw(asHome(lyrics()));
      await eventually(() => assert.ok(c.textContent?.includes("Sing it out, the night is over"), `the Home Lyrics never drew the words: "${c.textContent}"`));
      assert.ok(c.textContent?.includes("Chorus"));
    } finally {
      s.restore();
    }
  });
});

describe("the channel is read only while a Lyrics widget is on screen", () => {
  test("a layout with one reads ProPresenter's status", async () => {
    const s = serve();
    try {
      await draw(asWall(lyrics()));
      await eventually(() => assert.ok(s.paths.includes("/api/propresenter/status"), "a Lyrics widget never read the status"));
    } finally {
      s.restore();
    }
  });

  test("a layout without one does not", async () => {
    const s = serve();
    try {
      await draw(asWall(clock()));
      await settle();
      assert.equal(s.paths.includes("/api/propresenter/status"), false, "a clock read ProPresenter's status");
    } finally {
      s.restore();
    }
  });
});
