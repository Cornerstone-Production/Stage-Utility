// renderer/main/video/whep-client.ts — receive-only WHEP, no library.
//
// RTCPeerConnection works on plain HTTP (only getUserMedia needs a secure
// context), which is the whole reason this path exists on a LAN app.

export interface WhepSession {
  pc: RTCPeerConnection;
  /** Tells the relay, then closes locally. `ok: false` when the relay could not
   *  be told; it times the session out itself, so an unmount can ignore it. */
  stop: () => Promise<{ ok: boolean }>;
}

/** How long a DELETE may hold the peer connection open before it closes anyway. */
export const DELETE_CAP_MS = 3000;

/** A non-201 answer, carrying the status so a caller can tell "this relay
 *  feed's encoder cannot be carried over WebRTC at all" (400/406/415/422 —
 *  fall back to HLS) from "try again" (404 while a push feed's source has
 *  not connected yet, or a 5xx) — see use-video-session.ts's
 *  RELAY_WEBRTC_REFUSAL_STATUSES. */
export class WhepError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`WHEP ${status}`);
    this.name = "WhepError";
    this.status = status;
  }
}

/** DELETEs the session at `location`, resolved against the WHEP `endpoint` —
 *  NOT against the page's own origin. `location` is usually a path relative
 *  to the relay (an external feed's endpoint can be a different host
 *  entirely), and resolving it against `window.location.href` sent the
 *  DELETE to this app's own origin instead of the relay's. Best-effort, and
 *  capped at DELETE_CAP_MS: a session the relay never heard the DELETE for
 *  times out on its own. */
async function deleteSession(endpoint: URL, location: string): Promise<{ ok: boolean }> {
  const abort = new AbortController();
  const cap = setTimeout(() => abort.abort(), DELETE_CAP_MS);
  try {
    const r = await fetch(new URL(location, endpoint), { method: "DELETE", signal: abort.signal });
    return { ok: r.ok };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(cap);
  }
}

/**
 * Ends a session the relay created: the DELETE first, and the peer connection
 * closed only once it has been answered (or given up on). MediaMTX answers a
 * DELETE for a session whose peer connection already closed with 404 — 200
 * before the close — so closing first turned every teardown into a failed one.
 */
async function endSession(pc: RTCPeerConnection, endpoint: URL, location: string | null): Promise<{ ok: boolean }> {
  try {
    return location ? await deleteSession(endpoint, location) : { ok: true };
  } finally {
    pc.close();
  }
}

export async function startWhep(url: string, video: HTMLVideoElement, opts?: { signal?: AbortSignal }): Promise<WhepSession> {
  const endpoint = new URL(url, window.location.href);
  const pc = new RTCPeerConnection();
  // Guards a superseded attempt's late track: once THIS session has been
  // stopped or never got going, its ontrack must not steal the <video>
  // element out from under whatever replaced it. `stopped` alone misses the
  // real window: a caller that aborts (calls `stop()`, which is really just
  // `end()` from use-video-session.ts) WHILE `setRemoteDescription` is still
  // in flight leaves `stopped` false until that await returns — but the
  // caller's OWN abort signal is already true the moment it decided to move
  // on, and the browser can fire `track` for this session before the SRD
  // promise it belongs to ever settles.
  let stopped = false;
  pc.ontrack = (e) => {
    if (stopped || opts?.signal?.aborted) return;
    video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
  };
  // Null until the relay answers 201: only then is there a session on its side
  // to DELETE. Every failure before and after that point closes the peer
  // connection here, so no exit leaves one open.
  let location: string | null = null;
  try {
    pc.addTransceiver("video", { direction: "recvonly" });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await iceGatheringComplete(pc, 2000);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription!.sdp,
      signal: opts?.signal,
    });
    if (res.status !== 201) throw new WhepError(res.status);
    location = res.headers.get("Location");
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
  } catch (err) {
    // A 201 means the relay already created a session: leaving it dangling
    // because reading OUR half of the answer failed would leak it on the relay
    // until its own timeout, one more than every other exit.
    stopped = true;
    await endSession(pc, endpoint, location);
    throw err;
  }

  return {
    pc,
    stop() {
      stopped = true;
      return endSession(pc, endpoint, location);
    },
  };
}

function iceGatheringComplete(pc: RTCPeerConnection, capMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, capMs);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
    });
  });
}
