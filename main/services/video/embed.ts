// main/services/video/embed.ts — YouTube and Resi iframe players.
//
// Built server-side, once, so the wire carries a finished `src` and no screen
// assembles a URL from operator text.

import type { EmbedPlayer } from "../../types/video.js";

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYER_FLAGS = "autoplay=1&mute=1&controls=0&playsinline=1";

type Ref = { ok: true; ref: string } | { ok: false; error: string };

export function normalizeEmbedRef(player: EmbedPlayer, raw: string): Ref {
  const text = raw.trim();
  if (player === "youtube-channel") {
    const id = text.match(/(UC[A-Za-z0-9_-]{22})/)?.[1];
    if (id && CHANNEL_ID.test(id)) return { ok: true, ref: id };
    return {
      ok: false,
      error: "Use the channel ID, which starts with UC. It is in YouTube Studio under Settings, Channel, Advanced settings.",
    };
  }
  if (player === "youtube-video") {
    let id = text;
    try {
      const u = new URL(text);
      id = u.hostname === "youtu.be" ? u.pathname.slice(1) : (u.searchParams.get("v") ?? u.pathname.split("/").pop() ?? "");
    } catch {
      // Not a URL: a bare id, checked below.
    }
    return VIDEO_ID.test(id) ? { ok: true, ref: id } : { ok: false, error: "That is not a YouTube video or stream address." };
  }
  const src = text.match(/src="([^"]+)"/)?.[1] ?? text;
  try {
    const u = new URL(src);
    if (u.protocol === "https:" && u.hostname === "control.resi.io" && u.pathname.startsWith("/webplayer/")) {
      return { ok: true, ref: u.toString() };
    }
  } catch {
    // Falls through to the refusal.
  }
  return { ok: false, error: "Paste Resi's embed code or its player address (https://control.resi.io/webplayer/…)." };
}

export function embedSrc(player: EmbedPlayer, ref: string): string {
  if (player === "youtube-channel") return `https://www.youtube.com/embed/live_stream?channel=${ref}&${PLAYER_FLAGS}`;
  if (player === "youtube-video") return `https://www.youtube.com/embed/${ref}?${PLAYER_FLAGS}`;
  const u = new URL(ref);
  if (!u.searchParams.has("autoplay")) u.searchParams.set("autoplay", "true");
  if (!u.searchParams.has("mute")) u.searchParams.set("mute", "true");
  return u.toString();
}
