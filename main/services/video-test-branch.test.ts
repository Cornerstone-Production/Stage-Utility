// POST /api/integrations/video/test answers the relay's OWN status —
// running with its version, or the failing reason — instead of falling
// through to "No test available for integration: video".
//
// Seeded directly, never through integrationManager.init(): init() is the
// whole appliance coming up (Planning Center, wireless, OSC, SenSource...)
// and none of it is what is under test — see companion-connection-row.test.ts
// for the same pattern and why.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "video-test-branch-"));

const { integrationManager } = await import("./integration-manager.js");
const { videoService } = await import("./video/video-service.js");
const { videoFeedsStore } = await import("./video/feed-store.js");
const { DEFAULT_VIDEO_PORTS } = await import("../types/video.js");
const { fakeRelay } = await import("./fixtures/fake-relay.js");

type RelaySupervisorLike = import("./video/video-service.js").RelaySupervisorLike;

const states = (integrationManager as unknown as { states: Map<string, { id: string; enabled: boolean; connection: string; message: string | null; config: Record<string, unknown> }> }).states;

function seed(): void {
  states.set("video", { id: "video", enabled: true, connection: "disconnected", message: null, config: {} });
}


class FakeSupervisor {
  ver: string | null = "v1.21.1";
  status(): { state: "running"; since: number } {
    return { state: "running", since: Date.now() };
  }
  version(): string | null {
    return this.ver;
  }
  on(): this {
    return this;
  }
  off(): this {
    return this;
  }
}

beforeEach(() => {
  seed();
});

afterEach(async () => {
  await videoService.detachRelay();
  videoService.setPreAttachStatus(null);
  await videoFeedsStore.update((current) => ({ ...current, ports: DEFAULT_VIDEO_PORTS }));
});

test("video test: off answers not running, never the generic fallback", async () => {
  const r = await integrationManager.test("video");
  assert.equal(r.ok, false);
  assert.equal(r.message, "The video relay is not running.");
});

test("video test: running answers ok with the version", async () => {
  videoService.attachRelay(fakeRelay(), new FakeSupervisor() as unknown as RelaySupervisorLike, DEFAULT_VIDEO_PORTS);
  const r = await integrationManager.test("video");
  assert.equal(r.ok, true);
  assert.equal(r.message, "MediaMTX v1.21.1");
});

test("video test: failing answers the relay's own reason, not ok", async () => {
  videoService.setPreAttachStatus({
    state: "failing",
    reason: "Port 1935 is in use by OBS Studio.",
    kind: "port-conflict",
    retryAt: null,
  });
  const r = await integrationManager.test("video");
  assert.equal(r.ok, false);
  assert.equal(r.message, "Port 1935 is in use by OBS Studio.");
});

// The test button used to answer every
// non-running, non-failing state with the same generic "not running" line
// — reusing relay-lifecycle.ts's own relayConnectionState() (the ONE place
// a RelayStatus becomes a message) means "starting" and "downloading"
// answer with EXACTLY the words the connection row and the page's own
// status line already show, not a second, independently-worded mapping.
test("video test: starting answers with the SAME wording as the connection row, not ok", async () => {
  videoService.setPreAttachStatus({ state: "starting", version: null });
  const r = await integrationManager.test("video");
  assert.equal(r.ok, false);
  assert.equal(r.message, "Starting the relay");
});

test("video test: downloading answers with the SAME wording as the connection row, not ok", async () => {
  videoService.setPreAttachStatus({ state: "downloading", receivedBytes: 5_000_000, totalBytes: 27_000_000 });
  const r = await integrationManager.test("video");
  assert.equal(r.ok, false);
  assert.equal(r.message, "Downloading MediaMTX v1.21.1 (19%)");
});

// outOfBandSetup()'s own
// `.filter((f) => f.kind === "pull" || f.kind === "push")` had no test at
// all — every integration-manager test seeded a synthetic setup object
// (empty-schema-configured.test.ts) rather than exercising the real
// computation against real feeds, so deleting the filter left every test
// in the suite green. This drives it through the real
// videoFeedsStore/getStates() path.
test("video with only embed/external feeds is not configured; a pull or push feed makes it configured", async () => {
  // videoService.addFeed(), not a raw store write: outOfBandSetup() reads
  // videoService.current() — a cached snapshot that only refreshes through
  // videoService's own publish(), which only a real addFeed()/etc. call
  // triggers. A direct store write left the snapshot stale and the second
  // half of this exact test failing for the wrong reason (confirmed
  // directly before switching to this).
  const yt = await videoService.addFeed({
    name: "YouTube",
    source: { kind: "embed", player: "youtube-channel", ref: "UC1234567890123456789012" },
  });
  const ext = await videoService.addFeed({ name: "External", source: { kind: "external", url: "https://example.com/x.m3u8" } });
  assert.ok(yt.ok && ext.ok);
  try {
    const before = integrationManager.getStates().find((s) => s.id === "video");
    assert.equal(before?.configured, false, "embed/external feeds alone must not count as configured");

    const pull = await videoService.addFeed({ name: "Camera", source: { kind: "pull", url: "rtsp://192.0.2.1/x", username: "" } });
    assert.ok(pull.ok);
    try {
      const after = integrationManager.getStates().find((s) => s.id === "video");
      assert.equal(after?.configured, true, "a pull feed alongside the embed/external ones must count as configured");
    } finally {
      if (pull.ok) await videoService.removeFeed(pull.feed.id);
    }
  } finally {
    if (yt.ok) await videoService.removeFeed(yt.feed.id);
    if (ext.ok) await videoService.removeFeed(ext.feed.id);
  }
});
