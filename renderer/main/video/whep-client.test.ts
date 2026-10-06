// renderer/main/video/whep-client.test.ts — a fake RTCPeerConnection and a fake
// fetch on globalThis (assigned per test), no jsdom: nothing here touches the
// DOM beyond a plain object standing in for the <video> element. Most tests
// never fire `ontrack` at all; the two that do (a superseded attempt's late
// track, below) fire it directly rather than through a real MediaStream/track
// dispatch.

import { strict as assert } from "node:assert";
import { after, afterEach, mock, test } from "node:test";

import { startWhep } from "./whep-client.js";
import { FAKE_SDP, FakePeerConnection, installFakePeerConnection } from "../../test-fixtures/fake-peer-connection.js";

// window.location.href resolves a RELATIVE `url` argument into an absolute
// WHEP endpoint (an absolute `url`, e.g. an external feed's, is untouched by
// this) — not, any longer, where a Location header resolves; that is against
// the endpoint itself now (see whep-client.ts's deleteSession).
(globalThis as unknown as { window: unknown }).window = { location: { href: "http://localhost:8788/" } };

const restorePeerConnection = installFakePeerConnection();
after(restorePeerConnection);

const video = {} as HTMLVideoElement;

afterEach(() => {
  FakePeerConnection.reset();
});

test("a 201 with a Location DELETEs that address on stop", async () => {
  const calls: { method: string; url: string }[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input) });
    if (method === "POST") {
      return {
        status: 201,
        headers: { get: (h: string) => (h === "Location" ? "/video/p/whep/1f2e3d4c" : null) },
        text: async () => FAKE_SDP,
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
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
    ({ status: 404, ok: false, headers: { get: () => null }, text: async () => "" }) as unknown as Response) as typeof fetch;

  await assert.rejects(() => startWhep("/video/p/whep", video), /WHEP 404/);
  const pc = FakePeerConnection.instances.at(-1);
  assert.equal(pc?.closed, true, "expected the peer connection to be closed on a non-201 response");
});

test("a POST that fails outright closes the peer connection and rethrows", async () => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  await assert.rejects(() => startWhep("/video/p/whep", video), /fetch failed/);
  assert.equal(FakePeerConnection.instances.at(-1)?.closed, true, "a failed POST left the peer connection open");
});

test("an offer that cannot be made closes the peer connection and rethrows, with nothing POSTed", async () => {
  const posts: string[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_input: string | URL, init?: RequestInit) => {
    posts.push(init?.method ?? "GET");
    return { status: 201, ok: true, headers: { get: () => null }, text: async () => FAKE_SDP } as unknown as Response;
  }) as typeof fetch;
  const realCreateOffer = FakePeerConnection.prototype.createOffer;
  FakePeerConnection.prototype.createOffer = async () => {
    throw new Error("createOffer failed");
  };
  try {
    await assert.rejects(() => startWhep("/video/p/whep", video), /createOffer failed/);
  } finally {
    FakePeerConnection.prototype.createOffer = realCreateOffer;
  }
  assert.equal(FakePeerConnection.instances.at(-1)?.closed, true, "a failed offer left the peer connection open");
  assert.deepEqual(posts, [], "nothing should reach the relay when there is no offer");
});

test("an absolute, cross-origin endpoint's relative Location resolves against THAT origin, not the page's", async () => {
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
        text: async () => FAKE_SDP,
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

test("a 201 whose answer cannot be read closes the peer connection, DELETEs the session, and rethrows", async () => {
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

// ── a superseded attempt's late track ────────────────────────────────────
//
// These two fire `ontrack` from INSIDE `setRemoteDescription` (the fake's
// onSetRemoteDescription hook), to reproduce the real window the
// `stopped`-only guard missed — the caller's `end()` aborts the attempt
// (setting its AbortSignal, not yet `stopped`, since that only flips once
// `stop()` itself has been awaited) WHILE setRemoteDescription is still in
// flight, and the browser fires `track` for this now-abandoned session
// before that promise ever settles.

function stubFetchFor(path: string) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_input: string | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return {
        status: 201,
        ok: true,
        headers: { get: (h: string) => (h === "Location" ? path : null) },
        text: async () => FAKE_SDP,
      } as unknown as Response;
    }
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => "" } as unknown as Response;
  }) as typeof fetch;
}

test("a normal ontrack after stop() does not touch srcObject", async () => {
  stubFetchFor("/v/whep/x");
  const video = { srcObject: null as unknown } as unknown as HTMLVideoElement;

  const session = await startWhep("/v/whep", video);
  const pc = FakePeerConnection.instances.at(-1)!;
  const handler = pc.ontrack; // a browser keeps the handler after close(); grab it first
  await session.stop();
  handler?.({ streams: ["A"], track: {} });

  assert.equal(video.srcObject, null, "a track delivered after stop() must not set srcObject");
});

test("a session aborted while setRemoteDescription is in flight must not let its late track overwrite the replacement's stream", async () => {
  stubFetchFor("/v/whep/x");
  const video = { srcObject: null as unknown } as unknown as HTMLVideoElement;
  const controller = new AbortController();
  FakePeerConnection.onSetRemoteDescription = (pc) => {
    // The caller's end() runs while SRD is still in flight — this attempt's
    // signal is aborted, but `stopped` (whep-client.ts's own flag) is not
    // set until `stop()` itself is awaited, below.
    controller.abort();
    (video as unknown as { srcObject: unknown }).srcObject = "B"; // a newer attempt attaches
    pc.ontrack?.({ streams: ["A"], track: {} }); // SRD "completes": the browser fires track for THIS session
  };

  const session = await startWhep("/v/whep", video, { signal: controller.signal });
  await session.stop();

  assert.equal(video.srcObject, "B", "the abandoned session's late track must not overwrite the newer attempt's stream");
});

// ── the DELETE reaches the relay before the peer connection closes ────────
//
// MediaMTX answers a DELETE for a session whose peer connection has already
// closed with 404 (checked against v1.21.1: 200 before the close, 404 after),
// so closing first turned every teardown into a failed one.

function stubDeleteWith(answer: (init?: RequestInit) => Promise<Response>) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_input: string | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return {
        status: 201,
        headers: { get: (h: string) => (h === "Location" ? "/video/p/whep/abcd" : null) },
        text: async () => FAKE_SDP,
      } as unknown as Response;
    }
    FakePeerConnection.log.push(init?.method ?? "GET");
    return answer(init);
  }) as typeof fetch;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("stop() waits for the DELETE's answer before closing the peer connection", async () => {
  let answer!: (r: Response) => void;
  stubDeleteWith(() => new Promise<Response>((resolve) => (answer = resolve)));

  const session = await startWhep("/video/p/whep", video);
  const pc = FakePeerConnection.instances.at(-1)!;
  const stopping = session.stop();
  await flush();

  assert.deepEqual(FakePeerConnection.log, ["DELETE"], "the DELETE must be sent first");
  assert.equal(pc.closed, false, "the peer connection closed while the DELETE was still in flight");

  answer({ ok: true, status: 200 } as Response);
  assert.deepEqual(await stopping, { ok: true });
  assert.deepEqual(FakePeerConnection.log, ["DELETE", "close"]);
});

test("a bad answer DELETEs the session before closing the peer connection", async () => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_input: string | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return {
        status: 201,
        headers: { get: (h: string) => (h === "Location" ? "/video/p/whep/leaked" : null) },
        text: async () => {
          throw new Error("body already consumed");
        },
      } as unknown as Response;
    }
    FakePeerConnection.log.push(init?.method ?? "GET");
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  await assert.rejects(() => startWhep("/video/p/whep", video), /body already consumed/);
  assert.deepEqual(FakePeerConnection.log, ["DELETE", "close"]);
});

test("a DELETE that never answers still closes the peer connection after the cap", async () => {
  // Never answers, but rejects on abort the way the real fetch does.
  stubDeleteWith(
    (init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  const session = await startWhep("/video/p/whep", video);
  const pc = FakePeerConnection.instances.at(-1)!;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const stopping = session.stop();
    await flush();
    assert.equal(pc.closed, false);
    mock.timers.tick(3000);
    assert.deepEqual(await stopping, { ok: false });
    assert.equal(pc.closed, true, "a hung DELETE must not hold the peer connection open");
  } finally {
    mock.timers.reset();
  }
});
