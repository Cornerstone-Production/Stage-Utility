// seed/video.ts — video feeds. The relay is left off (it would download a binary),
// so the page shows the feeds as configured, with their addresses invented.

import type { Api } from "../lib/api.ts";
import type { Json } from "../lib/json.ts";

export async function seedVideo(api: Api) {
  const feeds = [
    { name: "Wide Camera", source: { kind: "pull", url: "rtsp://192.168.1.71:554/stream1", username: "viewer" } },
    { name: "Pastor Camera", source: { kind: "pull", url: "rtsp://192.168.1.72:554/stream1", username: "viewer" } },
    { name: "Stage Left Camera", source: { kind: "pull", url: "rtsp://192.168.1.73:554/stream1", username: "viewer" } },
    { name: "Livestream Encoder", source: { kind: "push", protocol: "srt" } },
    { name: "Overflow Feed", source: { kind: "push", protocol: "rtmp" } },
  ];
  const out: Json[] = [];
  for (const f of feeds) out.push((await api.post("/api/video/feeds", f)).feed);
  return out;
}
