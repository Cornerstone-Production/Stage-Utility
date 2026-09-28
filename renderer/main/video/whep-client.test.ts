// renderer/main/video/whep-client.test.ts — a fake RTCPeerConnection and a fake
// fetch on globalThis (assigned per test), no jsdom: nothing here touches the
// DOM beyond a plain object standing in for the <video> element, since ontrack
// is never fired in either case below.

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { startWhep } from "./whep-client.js";

// window.location.href is read only inside stop(), to resolve a relative
// Location header against the page's own origin.
(globalThis as unknown as { window: unknown }).window = { location: { href: "http://localhost:8788/" } };

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  iceGatheringState = "complete";
  localDescription: { sdp: string } | null = null;
  remoteDescription: unknown = null;
  ontrack: unknown = null;
  closed = false;
  constructor() {
    FakePeerConnection.instances.push(this);
  }
  addTransceiver(): void {}
  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n" };
  }
  async setLocalDescription(desc: { sdp: string }): Promise<void> {
    this.localDescription = desc;
  }
  async setRemoteDescription(desc: unknown): Promise<void> {
    this.remoteDescription = desc;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.closed = true;
  }
}

function stubPeerConnection(): void {
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection;
}

const video = {} as HTMLVideoElement;

afterEach(() => {
  FakePeerConnection.instances.length = 0;
});

test("a 201 with a Location DELETEs that address on stop", async () => {
  stubPeerConnection();
  const calls: { method: string; url: string }[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input) });
    if (method === "POST") {
      return {
        status: 201,
        headers: { get: (h: string) => (h === "Location" ? "/video/p/whep/1f2e3d4c" : null) },
        text: async () => "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
      } as unknown as Response;
    }
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => "" } as unknown as Response;
  }) as typeof fetch;

  const session = await startWhep("/video/p/whep", video);
  const result = await session.stop();

  assert.equal(result.ok, true, "expected stop() to report the DELETE as ok");
  const del = calls.find((c) => c.method === "DELETE");
  assert.ok(del, "expected a DELETE call to the relay");
  assert.equal(new URL(del!.url).pathname, "/video/p/whep/1f2e3d4c");
});

test("a 404 closes the peer connection and rejects", async () => {
  stubPeerConnection();
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
    ({ status: 404, ok: false, headers: { get: () => null }, text: async () => "" }) as unknown as Response) as typeof fetch;

  await assert.rejects(() => startWhep("/video/p/whep", video), /WHEP 404/);
  const pc = FakePeerConnection.instances.at(-1);
  assert.equal(pc?.closed, true, "expected the peer connection to be closed on a non-201 response");
});

test("an absolute, cross-origin endpoint's relative Location resolves against THAT origin, not the page's — Important 8", async () => {
  stubPeerConnection();
  const calls: { method: string; url: string }[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input) });
    if (method === "POST") {
      return {
        status: 201,
        // A relative path — exactly what MediaMTX sends — that must resolve
        // against the RELAY's origin, never against window.location.href
        // (this app's own origin, "http://localhost:8788/").
        headers: { get: (h: string) => (h === "Location" ? "/whep/9f8e7d6c" : null) },
        text: async () => "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
      } as unknown as Response;
    }
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => "" } as unknown as Response;
  }) as typeof fetch;

  const session = await startWhep("http://relay.example.org:8890/whep", video);
  await session.stop();

  const del = calls.find((c) => c.method === "DELETE");
  assert.ok(del, "expected a DELETE call");
  const url = new URL(del!.url);
  assert.equal(url.origin, "http://relay.example.org:8890", "the DELETE went to this app's own origin instead of the relay's");
  assert.equal(url.pathname, "/whep/9f8e7d6c");
});

test("a 201 whose answer cannot be read closes the peer connection, DELETEs the session, and rethrows — Minor 7", async () => {
  stubPeerConnection();
  const calls: { method: string; url: string }[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input) });
    if (method === "POST") {
      return {
        status: 201,
        headers: { get: (h: string) => (h === "Location" ? "/video/p/whep/leaked" : null) },
        text: async () => {
          throw new Error("body already consumed");
        },
      } as unknown as Response;
    }
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => "" } as unknown as Response;
  }) as typeof fetch;

  await assert.rejects(() => startWhep("/video/p/whep", video), /body already consumed/);

  const pc = FakePeerConnection.instances.at(-1);
  assert.equal(pc?.closed, true, "expected the peer connection closed rather than left open");
  const del = calls.find((c) => c.method === "DELETE");
  assert.ok(del, "expected the relay told to drop the session the 201 already created, not left to leak until its own timeout");
});
