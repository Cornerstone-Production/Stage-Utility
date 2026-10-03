// video-probe-subscription.test.tsx — the Video feeds page asks the server to
// check its cameras by subscribing to `video:probe`, and a frame pushed on that
// channel reaches the row.
//
// Its own file, with its own EventSource: api.ts keeps one stream per module
// instance, so the test that pushes a live frame has to be the first thing to
// open it — video-feeds-route.test.tsx opens one long before. What the page
// REPORTS to the server (/api/events/subscribe) is what starts the checks
// there; the EventSource's own listeners say nothing about it, because api.ts
// attaches a cache listener for every hydrated channel on its own.

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
// The editor beside the list renders a picture, which reads this; never on screen.
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
};

const { render, screen, cleanup, within, act } = await import("@testing-library/react");
const React = await import("react");
const { VideoFeedsRoute } = await import("./video-feeds-route.js");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");

after(() => unmountAndTeardown(cleanup, teardown));

type VideoState = import("@main/types/video").VideoState;

const STATE: VideoState = {
  rev: 1,
  relay: { state: "off" },
  kinds: ["pull", "push", "embed", "external"],
  ports: { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 },
  binaryPresent: true,
  archivePresent: true,
  screens: [],
  feeds: [
    {
      id: "cam",
      name: "Cam",
      kind: "pull",
      sourceLine: "Pulled from a device · rtsp://192.0.2.21:8554/stream2",
      source: { kind: "pull", url: "rtsp://192.0.2.21:8554/stream2", username: "" },
      play: { via: "relay", whep: "/video/cam/whep", hls: "/video/cam/index.m3u8" },
      status: { state: "standby" },
    },
  ],
};

const posts: { channels: string[] }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
  const path = String(url).split("?")[0]!;
  if (path.endsWith("/api/events/subscribe")) posts.push(JSON.parse(String(init?.body)) as { channels: string[] });
  const body = path.endsWith("/api/video/state")
    ? STATE
    : path.endsWith("/usage")
      ? { layouts: [] }
      : path.endsWith("/api/video/probe")
      ? { feeds: {} }
      : path.endsWith("/api/integrations")
        ? { descriptors: [{ id: "video", label: "Video feeds" }], states: [{ id: "video", enabled: true, connection: "disconnected", message: null, config: {} }] }
        : {};
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

test("the page reports video:probe as a channel it watches, and a pushed frame changes its row", async () => {
  const rootRoute = createRootRoute({ component: () => React.createElement(VideoFeedsRoute) });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  render(React.createElement(RouterProvider, { router } as never));
  await settle();
  await settle();

  // reportChannels() is debounced 200 ms.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(posts.length > 0, "the page reported no subscription at all");
  assert.ok(posts.at(-1)!.channels.includes("video:probe"), `video:probe missing from what the page reported: ${JSON.stringify(posts.at(-1))}`);

  const row = () => screen.getAllByText("Cam")[0]!.closest("button")!;
  assert.ok(within(row()).getByText("Standby"));

  await act(async () => {
    FakeEventSource.last!.push("video:probe", { feeds: { cam: { state: "ready", codec: "H265", checkedAt: Date.now() } } });
  });
  await settle();
  assert.ok(within(row()).getByText("Ready"), "the pushed frame did not reach the row");
  assert.match(within(row()).getByText(/^Camera answers/).textContent!, /^Camera answers · H\.265 · checked/);

  await act(async () => {
    FakeEventSource.last!.push("video:probe", { feeds: { cam: { state: "failed", reason: "192.0.2.21 is not reachable", checkedAt: Date.now() } } });
  });
  await settle();
  assert.ok(within(row()).getByText("Not answering"));
});
