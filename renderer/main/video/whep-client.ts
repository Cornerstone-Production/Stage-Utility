// renderer/main/video/whep-client.ts — receive-only WHEP, no library.
//
// RTCPeerConnection works on plain HTTP (only getUserMedia needs a secure
// context), which is the whole reason this path exists on a LAN app.

export interface WhepSession {
  pc: RTCPeerConnection;
  /** Closes locally, then tells the relay. `ok: false` when the relay could not
   *  be told; it times the session out itself, so an unmount can ignore it. */
  stop: () => Promise<{ ok: boolean }>;
}

/** DELETEs the session at `location`, resolved against the WHEP `endpoint` —
 *  NOT against the page's own origin. `location` is usually a path relative
 *  to the relay (an external feed's endpoint can be a different host
 *  entirely), and resolving it against `window.location.href` sent the
 *  DELETE to this app's own origin instead of the relay's. Best-effort: a
 *  session the relay never heard the DELETE for times out on its own. */
async function deleteSession(endpoint: URL, location: string): Promise<{ ok: boolean }> {
  try {
    const r = await fetch(new URL(location, endpoint), { method: "DELETE" });
    return { ok: r.ok };
  } catch {
    return { ok: false };
  }
}

export async function startWhep(url: string, video: HTMLVideoElement, opts?: { signal?: AbortSignal }): Promise<WhepSession> {
  const endpoint = new URL(url, window.location.href);
  const pc = new RTCPeerConnection();
  // Guards a superseded attempt's late track: once THIS session has been
  // stopped or never got going, its ontrack must not steal the <video>
  // element out from under whatever replaced it.
  let stopped = false;
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.ontrack = (e) => {
    if (stopped) return;
    video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await iceGatheringComplete(pc, 2000);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription!.sdp,
      signal: opts?.signal,
    });
  } catch (err) {
    stopped = true;
    pc.close();
    throw err;
  }
  if (res.status !== 201) {
    stopped = true;
    pc.close();
    throw new Error(`WHEP ${res.status}`);
  }
  const location = res.headers.get("Location");

  try {
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
  } catch (err) {
    // The relay already created a session for the 201 above — leaving it
    // dangling because reading OUR half of the answer failed would leak it
    // on the relay until its own timeout, one more than every other exit.
    stopped = true;
    pc.close();
    if (location) void deleteSession(endpoint, location);
    throw err;
  }

  return {
    pc,
    async stop() {
      stopped = true;
      pc.close();
      if (!location) return { ok: true };
      return deleteSession(endpoint, location);
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
