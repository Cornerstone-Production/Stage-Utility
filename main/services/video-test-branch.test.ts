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

type RelaySupervisorLike = import("./video/video-service.js").RelaySupervisorLike;
type VideoRelay = import("./video/relay.js").VideoRelay;

const states = (integrationManager as unknown as { states: Map<string, { id: string; enabled: boolean; connection: string; message: string | null; config: Record<string, unknown> }> }).states;

function seed(): void {
  states.set("video", { id: "video", enabled: true, connection: "disconnected", message: null, config: {} });
}

function fakeRelay(): VideoRelay {
  return {
    reconcile: async () => {},
    status: async () => [],
    playback: (feedId) => ({ whep: `/video/${feedId}/whep`, hls: `/video/${feedId}/index.m3u8` }),
    kickPublisher: async () => false,
  };
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
  videoService.setPreAttachStatus({ state: "failing", reason: "Port 1935 is in use by OBS Studio.", retryAt: null });
  const r = await integrationManager.test("video");
  assert.equal(r.ok, false);
  assert.equal(r.message, "Port 1935 is in use by OBS Studio.");
});
