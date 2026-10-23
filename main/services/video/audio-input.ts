// main/services/video/audio-input.ts — validating a feed's two audio settings.
//
// The audio source URL ends up as one argument of the command MediaMTX runs for
// the feed's `-listen` path (audio-listen.ts). MediaMTX splits that command with
// shell quoting rules and then expands `$NAME` in every word, so the address is
// held to a character set that neither step can read as anything but itself.
// The operator's address is stored as typed; it is this set, not a rewrite of
// the address, that keeps it from ever changing what runs.

import { AUDIO_CONVERSIONS, type AudioConversion } from "../../types/video.js";

/** Longest audio source address, in characters. */
export const MAX_AUDIO_URL_LENGTH = 1024;

/** What a command-line argument for MediaMTX's runOnDemand may hold: letters,
 *  digits and the URL punctuation that is neither a quote, a backslash, `$`, a
 *  backtick, a space, `#`, `<`, `>`, `|`, `^`, `{`, `}` nor a control character. */
const COMMAND_SAFE = /^[A-Za-z0-9\-._~:/?[\]@!&()*+,;=%]+$/;

/** Whether `text` can be one argument of a runOnDemand command exactly as it is. */
export function isCommandSafe(text: string): boolean {
  return COMMAND_SAFE.test(text);
}

export interface AudioFields {
  audioConversion?: AudioConversion;
  audioSourceUrl?: string;
}

/** Why `url` cannot be an audio source address, or null. */
export function audioSourceUrlProblem(url: string): string | null {
  if (url.length > MAX_AUDIO_URL_LENGTH) return `The audio source address must be at most ${MAX_AUDIO_URL_LENGTH} characters.`;
  if (!isCommandSafe(url)) {
    return "The audio source address can use only letters, digits and the punctuation - . _ ~ : / ? [ ] @ ! & ( ) * + , ; = %.";
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "The audio source address is invalid.";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "The audio source address must be http or https.";
  if (u.hostname === "") return "Enter the address, including the host (for example http://192.0.2.10/0.ts).";
  if (u.username !== "" || u.password !== "") {
    return "The audio source address cannot carry a username or password; use an address the encoder serves without one.";
  }
  return null;
}

/**
 * The two audio fields of a feed body. A default value is left out of the
 * result, so a feed that never touched them stores neither. `""` clears the
 * address. Anything of a wrong type is refused, not ignored.
 */
export function parseAudioFields(obj: Record<string, unknown>): { ok: true; fields: AudioFields } | { ok: false; error: string } {
  const fields: AudioFields = {};
  const conv = obj.audioConversion;
  if (conv !== undefined) {
    if (typeof conv !== "string" || !(AUDIO_CONVERSIONS as readonly string[]).includes(conv)) {
      return { ok: false, error: `Audio conversion must be one of: ${AUDIO_CONVERSIONS.join(", ")}.` };
    }
    if (conv !== "auto") fields.audioConversion = conv as AudioConversion;
  }
  const url = obj.audioSourceUrl;
  if (url !== undefined) {
    if (typeof url !== "string") return { ok: false, error: "The audio source address must be text." };
    const trimmed = url.trim();
    if (trimmed !== "") {
      const problem = audioSourceUrlProblem(trimmed);
      if (problem) return { ok: false, error: problem };
      fields.audioSourceUrl = trimmed;
    }
  }
  return { ok: true, fields };
}

/** The audio fields a stored feed or a file's feed carries, and nothing else, so
 *  a feed is rebuilt from `{ id, name, source, ...audioFieldsOf(x) }` without
 *  writing an `undefined` into the store. */
export function audioFieldsOf(feed: AudioFields): AudioFields {
  const out: AudioFields = {};
  if (feed.audioConversion !== undefined) out.audioConversion = feed.audioConversion;
  if (feed.audioSourceUrl !== undefined) out.audioSourceUrl = feed.audioSourceUrl;
  return out;
}
