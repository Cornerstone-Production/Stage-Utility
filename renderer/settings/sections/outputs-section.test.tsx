// outputs-section.test.tsx — the Screens card's struggling-feed warning box.
//
// Driven through the real OutputRow — the same component screens-route.tsx
// says the card IS ("This card is OutputsSection's OutputRow, extended") —
// with a `struggles` prop shaped the way OutputsSection computes it from a
// real video:state, never by reading source text or asserting on the copy
// function in isolation.
//
// NOT covered here, and not yet verified anywhere else either: the approved
// mockup shows the box sitting visually under the live preview with the
// app's own spacing and warn-tint colour. jsdom loads no stylesheet and
// reports every offsetHeight/getBoundingClientRect as zero, so neither is
// observable in this environment — a real browser has to confirm both.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert inspects
// `actual` to build its failure message, and inspecting a live jsdom element
// does not finish in any useful time.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, waitFor, within } = await import("@testing-library/react");
const React = await import("react");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { OutputRow, OutputsSection } = await import("./outputs-section.js");
const { DEFAULT_STAGE_STATE } = await import("../../main/test-render-ctx.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

type Output = import("@main/types/views").Output;
type VideoState = import("@main/types/video").VideoState;
type SectionHandlers = import("../types.js").SectionHandlers;

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});

const OUTPUT: Output = { id: "display-1", name: "Left Mic Display", viewId: null };

const TEST_PORTS = { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 };

/**
 * A minimal but real VideoState, the shape video:state hydrates the
 * OutputsSection-level test with (via GET /api/video/state — the same read
 * use-video-state.ts's useStatusChannel issues on mount). Two feeds, so the
 * "unrelated feed on the same screen is unaffected" case has something to
 * point at.
 */
function videoState(screens: VideoState["screens"]): VideoState {
  return {
    rev: 1,
    relay: { state: "off" },
    kinds: ["pull", "push", "embed", "external"],
    ports: TEST_PORTS,
    binaryPresent: true,
    archivePresent: true,
    feeds: [
      { id: "program", name: "Program (IMAG)", kind: "external", sourceLine: "x", source: { kind: "external", url: "x" }, play: { via: "external", url: "x", protocol: "whep" }, status: { state: null } },
      { id: "ptz", name: "Stage PTZ", kind: "external", sourceLine: "y", source: { kind: "external", url: "y" }, play: { via: "external", url: "y", protocol: "whep" }, status: { state: null } },
    ],
    screens,
  };
}

// ScreenDevice's own useDevices() fetches GET /api/devices on mount — stubbed
// to an empty bound list so the card renders no "machine showing this screen"
// strip. IconTint reaches for the shared stage-state hydrate on mount too
// (every icon-tinted control does), so /api/state is answered as well — both
// unrelated to what this file tests, but an unanswered request throws
// "window is not defined" once the DOM tears down under it. video:state is
// answered per test via `stubVideoState`, set fresh before each render.
let currentVideoState: VideoState = videoState([]);
function stubVideoState(state: VideoState): void {
  currentVideoState = state;
}
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const body = url.endsWith("/api/devices")
    ? { scanning: false, seen: [], matches: {}, bound: [] }
    : url.startsWith("/api/state")
      ? DEFAULT_STAGE_STATE
      : url.startsWith("/api/video/state")
        ? currentVideoState
        : null;
  if (body === null) throw new Error(`unexpected fetch in outputs-section.test.tsx: ${url}`);
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const NOOP_ASYNC = async () => {};

function renderRow(struggles: Parameters<typeof OutputRow>[0]["struggles"]) {
  return render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(OutputRow, {
        output: OUTPUT,
        views: [],
        baseUrl: "http://192.168.1.50:8788",
        online: true,
        struggles,
        canRemove: true,
        iconKey: OUTPUT.id,
        onRename: () => {},
        onRenameView: () => {},
        onSetSlug: NOOP_ASYNC,
        onSetView: () => {},
        onSetLocked: () => {},
        onSetHideTopBar: () => {},
        onSetAllowHls: () => {},
        onSetMode: NOOP_ASYNC,
        onRefresh: () => {},
        onRemove: () => {},
        onRequestNewView: () => {},
      }),
    ),
  );
}

test("a screen with nothing struggling shows no warning box at all", () => {
  renderRow([]);
  assert.equal(screen.queryByText(/Struggling with/) === null, true, "a clean screen must show no struggle box");
});

test("a struggling screen shows the lead sentence and the dropped-frames sentence, bold lead first", () => {
  renderRow([{ feedId: "program", feedName: "Program (IMAG)", droppedInWindow: 240, decodedInWindow: 1000, stallsInWindow: 0, width: 1920, height: 1080 }]);
  const box = screen.getByText(/Struggling with Program \(IMAG\)\./);
  assert.equal(box.tagName, "SPAN", "the lead sentence must be its own element (bold), not plain text run into the body");
  assert.equal(box.className.includes("font-semibold"), true, "the lead sentence must read bold");
  const container = within(box.parentElement!);
  assert.ok(container.getByText(/This screen dropped 240 frames in the last minute\./), "the dropped-frames sentence must follow the lead");
});

test("the 720p-encoder sentence appears only when the feed is taller than 720p", () => {
  renderRow([{ feedId: "program", feedName: "Program (IMAG)", droppedInWindow: 240, decodedInWindow: 1000, stallsInWindow: 0, width: 1920, height: 1080 }]);
  assert.ok(
    screen.getByText(/The feed is 1920 × 1080; a Pi 4 plays 1280 × 720 smoothly\. Lower the encoder's output to 720p\./),
    "a 1080p feed must carry the resolution sentence",
  );

  cleanup();
  renderRow([{ feedId: "program", feedName: "Program (IMAG)", droppedInWindow: 240, decodedInWindow: 1000, stallsInWindow: 0, width: 1280, height: 720 }]);
  assert.equal(
    screen.queryByText(/a Pi 4 plays/) === null,
    true,
    "a feed already at 720p or below must not carry the resolution sentence",
  );
});

test("the stall sentence appears only once stalls crossed STALLS_IN_WINDOW, using the exact count", () => {
  renderRow([{ feedId: "program", feedName: "Program (IMAG)", droppedInWindow: 240, decodedInWindow: 1000, stallsInWindow: 2, width: 1280, height: 720 }]);
  assert.equal(screen.queryByText(/stalled/) === null, true, "2 stalls (under STALLS_IN_WINDOW) must not carry the stall sentence");

  cleanup();
  renderRow([{ feedId: "program", feedName: "Program (IMAG)", droppedInWindow: 240, decodedInWindow: 1000, stallsInWindow: 3, width: 1280, height: 720 }]);
  assert.ok(
    screen.getByText(/It stalled 3 times; check this screen's network\./),
    "3 stalls (at STALLS_IN_WINDOW) must carry the stall sentence with the exact count",
  );
});

test("the mockup's own drops-at-1080 example reads exactly as before, sourced from the episode", () => {
  renderRow([{ feedId: "program", feedName: "Program (IMAG)", droppedInWindow: 240, decodedInWindow: 1000, stallsInWindow: 0, width: 1920, height: 1080 }]);
  const box = screen.getByText(/Struggling with Program \(IMAG\)\./).parentElement!;
  assert.equal(
    box.textContent,
    "Struggling with Program (IMAG). This screen dropped 240 frames in the last minute. " +
      "The feed is 1920 × 1080; a Pi 4 plays 1280 × 720 smoothly. Lower the encoder's output to 720p.",
  );
});

test("an episode that crossed stalls alone leads with the stall sentence and shows no dropped or 720 sentence, even above 720p", () => {
  renderRow([{ feedId: "program", feedName: "Program (IMAG)", droppedInWindow: 0, decodedInWindow: 900, stallsInWindow: 5, width: 1920, height: 1080 }]);
  const box = screen.getByText(/Struggling with Program \(IMAG\)\./).parentElement!;
  assert.equal(
    box.textContent,
    "Struggling with Program (IMAG). This screen stalled 5 times in the last minute; check its network.",
    "stalls alone must lead the box, and skip the dropped-frames and resolution sentences entirely",
  );
});

test("two struggling feeds on one screen render two separate boxes, each naming its own feed", () => {
  renderRow([
    { feedId: "program", feedName: "Program (IMAG)", droppedInWindow: 100, decodedInWindow: 1000, stallsInWindow: 0, width: 1280, height: 720 },
    { feedId: "ptz", feedName: "Stage PTZ", droppedInWindow: 50, decodedInWindow: 200, stallsInWindow: 0, width: 1280, height: 720 },
  ]);
  assert.ok(screen.getByText(/Struggling with Program \(IMAG\)\./));
  assert.ok(screen.getByText(/Struggling with Stage PTZ\./));
});

// ── The full wiring: OutputsSection itself, hydrated from a real video:state ──
//
// Everything above renders OutputRow directly with a hand-built `struggles`
// prop — proof the BOX'S OWN COPY is right. Nothing above touches how that
// prop gets BUILT: useVideoState()'s hydrate, filtering to struggling pairs
// only, and resolving a feedId to the feed's name. This is that path, through
// the real OutputsSection component, the same one screens-route.tsx renders.

const NOOP_HANDLERS = {
  sensors: [],
  handleRenameView: async () => {},
} as unknown as SectionHandlers;

function stageStateWith(outputs: Output[]) {
  return { outputs, views: [], iconColors: {}, publicUrl: "" } as unknown as Parameters<typeof OutputsSection>[0]["stageState"];
}

test("OutputsSection shows the struggling feed's box, correctly naming it from video:state.feeds — and nothing for a feed reporting clean", async () => {
  stubVideoState(
    videoState([
      { outputId: OUTPUT.id, feedId: "program", via: "webrtc", struggling: true, droppedInWindow: 300, decodedInWindow: 4000, stallsInWindow: 0, width: 1920, height: 1080, reportedAt: Date.now(), episode: { droppedInWindow: 300, decodedInWindow: 4000, stallsInWindow: 0, width: 1920, height: 1080 } },
      { outputId: OUTPUT.id, feedId: "ptz", via: "webrtc", struggling: false, droppedInWindow: 5, decodedInWindow: 4000, stallsInWindow: 0, width: 1280, height: 720, reportedAt: Date.now(), episode: null },
    ]),
  );
  render(
    React.createElement(TooltipProvider, null, React.createElement(OutputsSection, { stageState: stageStateWith([OUTPUT]), handlers: NOOP_HANDLERS })),
  );

  await waitFor(() => assert.ok(screen.getByText(/Struggling with Program \(IMAG\)\./)));
  assert.ok(screen.getByText(/This screen dropped 300 frames in the last minute\./), "the box must carry THIS pair's own EPISODE numbers, not a placeholder");
  assert.equal(screen.queryByText(/Struggling with Stage PTZ/) === null, true, "a feed reporting clean on the same screen must get no box");
});

test("OutputsSection builds the box from the pair's episode, not its live window, when the two differ", async () => {
  // The live window has diluted to 60 of 1000 at 720p with no stalls; the
  // episode, the worst minute of this struggle, was 240 dropped at 1080p with
  // 4 stalls. Every number in the box must be the episode's.
  stubVideoState(
    videoState([
      { outputId: OUTPUT.id, feedId: "program", via: "webrtc", struggling: true, droppedInWindow: 60, decodedInWindow: 1000, stallsInWindow: 0, width: 1280, height: 720, reportedAt: Date.now(), episode: { droppedInWindow: 240, decodedInWindow: 1000, stallsInWindow: 4, width: 1920, height: 1080 } },
    ]),
  );
  render(
    React.createElement(TooltipProvider, null, React.createElement(OutputsSection, { stageState: stageStateWith([OUTPUT]), handlers: NOOP_HANDLERS })),
  );

  await waitFor(() => assert.ok(screen.getByText(/Struggling with Program \(IMAG\)\./)));
  const box = screen.getByText(/Struggling with Program \(IMAG\)\./).parentElement!;
  assert.equal(
    box.textContent,
    "Struggling with Program (IMAG). This screen dropped 240 frames in the last minute. " +
      "The feed is 1920 × 1080; a Pi 4 plays 1280 × 720 smoothly. Lower the encoder's output to 720p. " +
      "It stalled 4 times; check this screen's network.",
  );
});

test("OutputsSection routes each screen's own struggles to its own card — a second, healthy screen shows no box for the first screen's struggle", async () => {
  const OTHER: Output = { id: "display-2", name: "Right Mic Display", viewId: null };
  stubVideoState(
    videoState([
      { outputId: OUTPUT.id, feedId: "program", via: "webrtc", struggling: true, droppedInWindow: 300, decodedInWindow: 4000, stallsInWindow: 0, width: 1920, height: 1080, reportedAt: Date.now(), episode: { droppedInWindow: 300, decodedInWindow: 4000, stallsInWindow: 0, width: 1920, height: 1080 } },
      { outputId: OTHER.id, feedId: "program", via: "webrtc", struggling: false, droppedInWindow: 0, decodedInWindow: 4000, stallsInWindow: 0, width: 1920, height: 1080, reportedAt: Date.now(), episode: null },
    ]),
  );
  render(
    React.createElement(TooltipProvider, null, React.createElement(OutputsSection, { stageState: stageStateWith([OUTPUT, OTHER]), handlers: NOOP_HANDLERS })),
  );

  await waitFor(() => assert.ok(screen.getByText(/Struggling with Program \(IMAG\)\./)));
  // Exactly one box, not one per card — the same feed struggling on ONE
  // screen must not paint a warning on a screen playing it cleanly.
  assert.equal(screen.getAllByText(/Struggling with Program \(IMAG\)\./).length, 1, "only the struggling screen's own card gets a box");

  // The name is an editable field's VALUE (an <input>), not a text node —
  // getByDisplayValue is what matches that, not getByText. OutputRow's own
  // root div carries this exact class, unique to a screen card's outer
  // container (matched by a fixed classname substring rather than a guessed
  // number of parentElement hops, which would break the moment the markup
  // between the name field and the card root changes shape).
  const rightCard = screen.getByDisplayValue("Right Mic Display").closest('[class*="rounded-xl"]') as HTMLElement;
  assert.ok(rightCard, "expected the second screen's own card root");
  assert.equal(within(rightCard).queryByText(/Struggling with/), null, "the healthy second screen's own card must carry no box at all");
});

test("OutputsSection shows no struggle box for any screen before video:state has hydrated struggling data", async () => {
  stubVideoState(videoState([]));
  render(
    React.createElement(TooltipProvider, null, React.createElement(OutputsSection, { stageState: stageStateWith([OUTPUT]), handlers: NOOP_HANDLERS })),
  );
  await waitFor(() => assert.ok(screen.getByText("Nothing assigned"))); // the unrouted-screen placeholder — proof the card mounted
  assert.equal(screen.queryByText(/Struggling with/) === null, true);
});
