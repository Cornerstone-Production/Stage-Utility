// main/services/video/feed-input.ts — validate operator input for a feed source.

import { PUSH_PROTOCOLS, EMBED_PLAYERS, type VideoSourceKind, type VideoSource } from "../../types/video.js";
import { normalizeEmbedRef } from "./embed.js";

/** Longest name a feed may have, after trimming. */
export const MAX_NAME_LENGTH = 60;

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/** A username or password inside the address itself. Refused for every kind
 *  that takes an address: stored there it would sit in the config store and
 *  go out on video:state to every screen, and a browser refuses to fetch an
 *  address that carries one, so it could never play either. */
function hasUserinfo(u: URL): boolean {
  return u.username !== "" || u.password !== "";
}

/** Printable ASCII, space to tilde — what an encoder's own settings page
 *  takes for an SRT passphrase, and what makes the length rule's
 *  "characters" the same count as MediaMTX's bytes. */
const PLAIN_ASCII = /^[\x20-\x7E]*$/;

export function parseFeedInput(
  body: unknown,
  allowKinds: ReadonlySet<VideoSourceKind>,
): { ok: true; name: string; source: VideoSource; password?: string } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Invalid input." };
  }

  const obj = body as Record<string, unknown>;

  // Validate name
  if (obj.name === undefined) {
    return { ok: false, error: "Name is required." };
  }
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Name must be 1–${MAX_NAME_LENGTH} characters.` };
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
      // Not pull's "their own fields" wording: this kind has no such fields.
      if (hasUserinfo(u)) {
        return { ok: false, error: "Take the username and password out of the address: browsers refuse to play one that carries them." };
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

    if (hasUserinfo(url)) {
      return { ok: false, error: "Put the username and password in their own fields, not the address." };
    }

    const username = typeof source.username === "string" ? source.username : "";
    if (username.length > 100) {
      return { ok: false, error: "Username must be at most 100 characters." };
    }

    if (obj.password !== undefined && typeof obj.password !== "string") {
      return { ok: false, error: "The password must be text." };
    }
    const password = typeof obj.password === "string" ? obj.password : undefined;
    if (password && password.length > 200) {
      return { ok: false, error: "Password must be at most 200 characters." };
    }

    // SRT authenticates a pull by passphrase alone (reconcile-plan.ts's
    // pullSource puts it in the query and has nowhere for a username), and
    // MediaMTX refuses a passphrase outside 10 to 80 bytes on every dial,
    // for as long as the feed exists. Plain ASCII only, so a character is a
    // byte and the length sentence is exact.
    if (url.protocol === "srt:") {
      if (username !== "") return { ok: false, error: "SRT uses a passphrase only, no username: leave Username empty." };
      if (password && !PLAIN_ASCII.test(password)) {
        return { ok: false, error: "An SRT passphrase can use only plain letters, digits, spaces and punctuation." };
      }
      if (password && (password.length < 10 || password.length > 80)) {
        return { ok: false, error: "An SRT passphrase must be 10 to 80 characters long." };
      }
    }

    const result: { ok: true; name: string; source: VideoSource; password?: string } = {
      ok: true,
      name,
      source: {
        kind: "pull",
        url: source.url,
        username,
      },
    };
    // `!== undefined`, not truthy: `password: ""` is how an update explicitly
    // CLEARS a stored password (video-service.ts's updateFeed), and a truthy
    // check here dropped that "" on the floor before it ever reached the
    // caller, so a PATCH carrying it silently left the old password in place
    // — the same bug class CLAUDE.md names for wireless.
    if (password !== undefined) result.password = password;
    return result;
  }

  if (kind === "push") {
    if (typeof source.protocol !== "string") {
      return { ok: false, error: "Push source protocol is required." };
    }
    if (!isOneOf(PUSH_PROTOCOLS, source.protocol)) {
      return { ok: false, error: `Push protocol must be one of: ${PUSH_PROTOCOLS.join(", ")}.` };
    }
    return { ok: true, name, source: { kind: "push", protocol: source.protocol } };
  }

  if (kind === "embed") {
    if (typeof source.player !== "string") {
      return { ok: false, error: "Embed player is required." };
    }
    if (!isOneOf(EMBED_PLAYERS, source.player)) {
      return { ok: false, error: `Embed player must be one of: ${EMBED_PLAYERS.join(", ")}.` };
    }
    if (typeof source.ref !== "string") {
      return { ok: false, error: "Embed ref is required." };
    }

    const normalized = normalizeEmbedRef(source.player, source.ref);
    if (!normalized.ok) {
      return { ok: false, error: normalized.error };
    }

    return {
      ok: true,
      name,
      source: {
        kind: "embed",
        player: source.player,
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
