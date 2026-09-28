// main/services/video/feed-input.ts — validate operator input for a feed source.

import { PUSH_PROTOCOLS, EMBED_PLAYERS, type VideoSourceKind, type VideoSource } from "../../types/video.js";
import { normalizeEmbedRef } from "./embed.js";

export function parseFeedInput(
  body: unknown,
  allowKinds: ReadonlySet<VideoSourceKind>,
): { ok: true; name: string; source: VideoSource; password?: string } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Invalid input." };
  }

  const obj = body as Record<string, unknown>;

  // Validate name
  if (typeof obj.name !== "string") {
    return { ok: false, error: "Name is required." };
  }
  const name = obj.name.trim();
  if (name.length === 0 || name.length > 60) {
    return { ok: false, error: "Name must be 1–60 characters." };
  }

  // Validate source exists and has kind
  if (typeof obj.source !== "object" || obj.source === null) {
    return { ok: false, error: "Source is required." };
  }
  const source = obj.source as Record<string, unknown>;
  if (typeof source.kind !== "string") {
    return { ok: false, error: "Source kind is required." };
  }

  const kind = source.kind as VideoSourceKind;
  if (!allowKinds.has(kind)) {
    return { ok: false, error: `This build does not offer ${kind}.` };
  }

  // Validate per kind
  if (kind === "external") {
    if (typeof source.url !== "string") {
      return { ok: false, error: "External source URL is required." };
    }
    try {
      const u = new URL(source.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, error: "External URL must be http or https." };
      }
      return { ok: true, name, source: { kind: "external", url: source.url } };
    } catch {
      return { ok: false, error: "External URL is invalid." };
    }
  }

  if (kind === "pull") {
    if (typeof source.url !== "string") {
      return { ok: false, error: "Pull source URL is required." };
    }
    if (typeof source.username !== "string") {
      return { ok: false, error: "Pull source username is required." };
    }

    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      return { ok: false, error: "Pull source URL is invalid." };
    }

    const validProtocols = ["rtsp:", "rtsps:", "srt:", "http:", "https:"];
    if (!validProtocols.includes(url.protocol)) {
      return { ok: false, error: "Pull source protocol must be rtsp, rtsps, srt, http, or https." };
    }

    if (url.username || url.password) {
      return { ok: false, error: "Put the username and password in their own fields, not the address." };
    }

    if (typeof source.username === "string" && source.username.length > 100) {
      return { ok: false, error: "Username must be at most 100 characters." };
    }

    const password = typeof obj.password === "string" ? obj.password : undefined;
    if (password && password.length > 200) {
      return { ok: false, error: "Password must be at most 200 characters." };
    }

    const result: { ok: true; name: string; source: VideoSource; password?: string } = {
      ok: true,
      name,
      source: {
        kind: "pull",
        url: source.url,
        username: source.username,
      },
    };
    if (password) result.password = password;
    return result;
  }

  if (kind === "push") {
    if (typeof source.protocol !== "string") {
      return { ok: false, error: "Push source protocol is required." };
    }
    if (!PUSH_PROTOCOLS.includes(source.protocol as any)) {
      return { ok: false, error: `Push protocol must be one of: ${PUSH_PROTOCOLS.join(", ")}.` };
    }
    return { ok: true, name, source: { kind: "push", protocol: source.protocol as any } };
  }

  if (kind === "embed") {
    if (typeof source.player !== "string") {
      return { ok: false, error: "Embed player is required." };
    }
    if (!EMBED_PLAYERS.includes(source.player as any)) {
      return { ok: false, error: `Embed player must be one of: ${EMBED_PLAYERS.join(", ")}.` };
    }
    if (typeof source.ref !== "string") {
      return { ok: false, error: "Embed ref is required." };
    }

    const normalized = normalizeEmbedRef(source.player as any, source.ref);
    if (!normalized.ok) {
      return { ok: false, error: normalized.error };
    }

    return {
      ok: true,
      name,
      source: {
        kind: "embed",
        player: source.player as any,
        ref: normalized.ref,
      },
    };
  }

  return { ok: false, error: "Unknown source kind." };
}

export function externalProtocol(url: string): "whep" | "hls" {
  const u = new URL(url);
  return u.pathname.endsWith(".m3u8") ? "hls" : "whep";
}
