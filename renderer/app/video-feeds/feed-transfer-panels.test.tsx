// feed-transfer-panels.test.tsx — Export and Import on the Video feeds page,
// driven through the real route with a stubbed fetch.
//
// Not covered, and why: jsdom loads no stylesheet and reports every
// offsetHeight as zero, so the panel's placement beside the list, the tag
// colours and the diff line's strike-through are checked in a real browser, not
// here. The download itself is the browser following an <a download>; what is
// asserted is the address it would follow.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { VideoFeedsRoute } = await import("./video-feeds-route.js");
const { exportHref } = await import("./feed-transfer-panels.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");

type VideoState = import("@main/types/video").VideoState;
type VideoFeedView = import("@main/types/video").VideoFeedView;

after(() => unmountAndTeardown(cleanup, teardown));

class StubIntersectionObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

const PORTS = { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 };

const FEEDS: VideoFeedView[] = [
  {
    id: "box", name: "BOX", kind: "pull", sourceLine: "", hasPassword: true,
    source: { kind: "pull", url: "rtsp://192.0.2.31:554/box", username: "" },
    play: { via: "relay", whep: "/video/box/whep", hls: "/video/box/index.m3u8" }, status: { state: "standby" },
  },
  {
    id: "obs", name: "OBS Lobby", kind: "push", sourceLine: "",
    source: { kind: "push", protocol: "srt" },
    play: { via: "relay", whep: "/video/obs/whep", hls: "/video/obs/index.m3u8" }, status: { state: "waiting" },
  },
  {
    id: "resi", name: "Resi", kind: "embed", sourceLine: "",
    source: { kind: "embed", player: "resi", ref: "https://control.resi.io/x" },
    play: { via: "embed", src: "https://control.resi.io/x" }, status: { state: "embed" },
  },
];

const STATE: VideoState = {
  rev: 1, relay: { state: "off" }, kinds: ["pull", "push", "embed", "external"], ports: PORTS,
  binaryPresent: true, archivePresent: true, feeds: FEEDS, screens: [],
};

const PREVIEW = {
  server: "Prod", createdAt: "2026-10-01T00:00:00.000Z", hasPasswords: false,
  feeds: [
    { id: "box", name: "BOX", kind: "pull", status: "differs", differences: [{ field: "url", here: "rtsp://192.0.2.31:554/box", file: "rtsp://192.0.2.99:554/box" }] },
    { id: "gym", name: "GYM", kind: "pull", status: "new", differences: [] },
    { id: "resi", name: "Resi", kind: "embed", status: "same", differences: [] },
    { id: "odd", name: "Odd", kind: "teleport", status: "invalid", differences: [], error: "This build does not offer teleport." },
  ],
  absent: ["OBS Lobby"],
  ports: { file: { ...PORTS, rtmp: 2935 }, here: PORTS, same: false },
};

const FILE = {
  kind: "stage-utility-video-feeds", version: 1, appVersion: "1", createdAt: "x", source: { server: "Prod" },
  feeds: [
    { id: "box", name: "BOX", source: { kind: "pull", url: "rtsp://192.0.2.99:554/box", username: "" } },
    { id: "gym", name: "GYM", source: { kind: "pull", url: "rtsp://192.0.2.50:554/gym", username: "" } },
    { id: "resi", name: "Resi", source: FEEDS[2]!.source },
    { id: "odd", name: "Odd", source: { kind: "teleport" } },
  ],
  ports: { ...PORTS, rtmp: 2935 },
};

interface Call { method: string; url: string; body?: unknown }

function stub(report: unknown = { added: ["GYM"], replaced: ["BOX"], kept: [], same: ["Resi"], skipped: [{ name: "Odd", reason: "This build does not offer teleport." }], newPushPasswords: ["OBS"], passwordsWritten: 0, portsApplied: false }) {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  const realIo = (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as unknown as Response;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/api/video/state")) return ok(STATE);
    if (url.endsWith("/api/integrations")) return ok({ descriptors: [], states: [] });
    if (url.endsWith("/usage")) return ok({ layouts: [] });
    if (/\/push(\?.*)?$/.test(url)) return ok({ protocol: "srt", address: "srt://192.0.2.1:8890", password: "x" });
    if (url.endsWith("/api/video/import/preview")) return ok(PREVIEW);
    if (url.endsWith("/api/video/import")) return ok(report);
    return ok({});
  }) as typeof fetch;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = StubIntersectionObserver;
  return {
    calls,
    restore() {
      globalThis.fetch = real;
      (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realIo;
    },
  };
}

function mount() {
  const root = createRootRoute({ component: () => React.createElement(VideoFeedsRoute) });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  return render(React.createElement(RouterProvider, { router } as never));
}

beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});
afterEach(() => cleanup());

const link = () => screen.getByRole("link", { name: /Download/ }) as HTMLAnchorElement;

test("exportHref sends no feeds= for every feed, so a later feed is not left out", () => {
  const all = ["a", "b"];
  assert.equal(exportHref({ allIds: all, chosenIds: all, ports: false, passwords: false }), "/api/video/export");
  assert.equal(exportHref({ allIds: all, chosenIds: ["b"], ports: true, passwords: true }), "/api/video/export?feeds=b&ports=1&passwords=1");
});

test("Export opens in place of the editor, builds its link from the ticks, and reads Choose a feed with none", async () => {
  const g = stub();
  try {
    mount();
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await settle();

    assert.equal(screen.getByRole("button", { name: /Export/ }).getAttribute("aria-pressed"), "true");
    assert.equal(screen.queryByLabelText("Feed settings"), null, "the editor is replaced, not shown beside");
    assert.equal(link().getAttribute("href"), "/api/video/export");
    assert.ok(screen.getByText("All 3 feeds"));

    fireEvent.click(screen.getByRole("checkbox", { name: "OBS Lobby" }));
    await settle();
    assert.ok(screen.getByText("2 of 3 feeds"));
    assert.equal(screen.getByRole("checkbox", { name: "All feeds" }).getAttribute("aria-checked"), "mixed");
    assert.equal(link().getAttribute("href"), "/api/video/export?feeds=box,resi");

    fireEvent.click(screen.getByRole("checkbox", { name: "Relay ports" }));
    await settle();
    assert.equal(link().getAttribute("href"), "/api/video/export?feeds=box,resi&ports=1");

    fireEvent.click(screen.getByRole("checkbox", { name: "Passwords" }));
    await settle();
    assert.equal(link().getAttribute("href"), "/api/video/export?feeds=box,resi&ports=1&passwords=1");
    assert.ok(screen.getByText(/in plain text/), "the warning shows with passwords ticked");
    assert.ok(screen.getByText(/log in to the BOX camera/));
    assert.equal(screen.queryByText(/publish to OBS Lobby/), null, "OBS Lobby is unticked, so it is not named");

    fireEvent.click(screen.getByRole("checkbox", { name: "All feeds" }));
    await settle();
    fireEvent.click(screen.getByRole("checkbox", { name: "All feeds" }));
    await settle();
    assert.equal(screen.queryByRole("link", { name: /Download/ }), null);
    const disabled = screen.getByRole("button", { name: "Choose a feed" }) as HTMLButtonElement;
    assert.equal(disabled.disabled, true);
  } finally {
    g.restore();
  }
});

test("Import: pick a file, review it, choose, and the request carries exactly the choices", async () => {
  const g = stub();
  try {
    const { container } = mount();
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Import/ }));
    await settle();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(FILE)], "feeds.json", { type: "application/json" })] } });
    await settle();
    await settle();

    const preview = g.calls.find((c) => c.url.endsWith("/api/video/import/preview"));
    assert.ok(preview, "the file was not sent for review");
    assert.deepEqual(preview!.body, FILE);

    assert.ok(screen.getByText(/feeds\.json · from Prod · 4 feeds · no passwords/));
    assert.ok(screen.getByText("Differs"));
    assert.ok(screen.getByText("New"));
    assert.ok(screen.getByText("Same as here"));
    assert.ok(screen.getByText("Can't import"));
    assert.ok(screen.getByText("This build does not offer teleport."));
    assert.ok(screen.getByText("rtsp://192.0.2.50:554/gym"), "a new feed shows where it comes from");
    assert.ok(screen.getByText(/OBS Lobby is not in the file/));
    assert.ok(screen.getByRole("button", { name: "Import 2 feeds" }), "new plus replace");

    // The default for a differing feed is the file's; keeping this server's drops it from the count.
    const pick = container.querySelector('select[aria-label="BOX: which to keep"]') as HTMLSelectElement;
    assert.equal(pick.value, "replace");
    fireEvent.change(pick, { target: { value: "keep" } });
    await settle();
    assert.ok(screen.getByRole("button", { name: "Import 1 feed" }));
    fireEvent.change(pick, { target: { value: "replace" } });
    await settle();

    // Ports are off until asked for.
    const ports = screen.getByRole("checkbox", { name: "Use the file's relay ports" });
    assert.equal(ports.getAttribute("aria-checked"), "false");
    fireEvent.click(ports);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Import 2 feeds" }));
    await settle();
    await settle();

    const apply = g.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/video/import"));
    assert.ok(apply, "Import never posted");
    assert.deepEqual(apply!.body, { bundle: FILE, choices: { box: "replace" }, ports: true });

    assert.ok(screen.getByText("Imported 2 feeds"));
    assert.ok(screen.getByText(/Added GYM/));
    assert.ok(screen.getByText(/Replaced BOX with the file's/));
    assert.ok(screen.getByText(/Resi was already the same/));
    assert.ok(screen.getByText(/Skipped Odd: This build does not offer teleport\./));
    assert.ok(screen.getByText(/OBS has a new publish password on this server: paste the new publish password into each device/));
    assert.ok(screen.getByText(/GYM is pulled from a device/));
    assert.ok(screen.getByRole("button", { name: "Import another" }));
  } finally {
    g.restore();
  }
});

test("Import with this server's feed kept and the ports left alone says exactly that", async () => {
  const g = stub();
  try {
    const { container } = mount();
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Import/ }));
    await settle();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(FILE)], "feeds.json")] } });
    await settle();
    await settle();
    fireEvent.change(container.querySelector('select[aria-label="BOX: which to keep"]') as HTMLSelectElement, { target: { value: "keep" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Import 1 feed" }));
    await settle();
    await settle();
    const apply = g.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/video/import"));
    assert.deepEqual(apply!.body, { bundle: FILE, choices: { box: "keep" }, ports: false });
  } finally {
    g.restore();
  }
});

test("Import refuses a file of the wrong kind by name, without sending it", async () => {
  const g = stub();
  try {
    const { container } = mount();
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Import/ }));
    await settle();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([JSON.stringify({ kind: "stage-utility-view", views: [] })], "view.json")] } });
    await settle();
    await settle();
    assert.ok(screen.getByText(/That is a "stage-utility-view" file, not a video feeds export\./));
    assert.equal(g.calls.some((c) => c.url.includes("/import")), false);
  } finally {
    g.restore();
  }
});

test("selecting a feed or Add feed returns to the editor", async () => {
  const g = stub();
  try {
    mount();
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await settle();
    assert.ok(screen.getByRole("complementary", { name: "Export video feeds" }));
    fireEvent.click(screen.getByRole("button", { name: /Add feed/ }));
    await settle();
    assert.equal(screen.queryByRole("complementary", { name: "Export video feeds" }), null);
    assert.ok(screen.getByRole("complementary", { name: "Feed settings" }));
  } finally {
    g.restore();
  }
});
