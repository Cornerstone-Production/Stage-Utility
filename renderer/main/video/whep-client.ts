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

export async function startWhep(url: string, video: HTMLVideoElement): Promise<WhepSession> {
  const pc = new RTCPeerConnection();
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.ontrack = (e) => {
    video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await iceGatheringComplete(pc, 2000);

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: pc.localDescription!.sdp });
  } catch (err) {
    pc.close();
    throw err;
  }
  if (res.status !== 201) {
    pc.close();
    throw new Error(`WHEP ${res.status}`);
  }
  const location = res.headers.get("Location");
  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });

  return {
    pc,
    async stop() {
      pc.close();
      if (!location) return { ok: true };
      try {
        const r = await fetch(new URL(location, window.location.href), { method: "DELETE" });
        return { ok: r.ok };
      } catch {
        return { ok: false };
      }
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
