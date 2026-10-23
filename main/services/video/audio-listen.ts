// main/services/video/audio-listen.ts — the `<feed>-listen` relay path: when a
// feed needs one, what it runs, and what the feed reports about its audio.
//
// A browser listening live gets its sound over WebRTC, which carries Opus and
// G.711 but not AAC (what the Ultra Encodes send). A feed's `-listen` path is a
// second relay path that holds the same video plus Opus. MediaMTX starts the
// command below the moment the first reader asks for the path and stops it a
// while after the last one leaves (runOnDemand), so exactly one ffmpeg runs per
// listened feed whoever and however many are listening, and none otherwise.
//
// Two ways to fill that path:
//   convert      ffmpeg reads the feed's own copy from the relay (never the
//                encoder, which refuses a second RTSP reader), copies the video
//                and re-encodes the audio to Opus. One process, one clock: the
//                two stay in sync.
//   pass-through ffmpeg reads the audio source address the operator named (an
//                encoder's HTTP stream that already carries Opus) and republishes
//                it with `-c copy`. No re-encode.
//
// Everything here is pure. video-service.ts feeds it what the relay reports and
// what ffmpeg-system.ts found; reconcile-plan.ts turns the command into a path.

import type { AudioConversion, FeedAudioStatus } from "../../types/video.js";
import { audioSourceUrlProblem } from "./audio-input.js";
import { normalizeCodecName } from "./codec-name.js";
import { FEED_ID_PATTERN, LISTEN_SUFFIX, isReservedFeedId } from "./feed-id.js";

/** The relay path a converter publishes to for feed `id`. */
export function listenPathName(id: string): string {
  return `${id}${LISTEN_SUFFIX}`;
}

/** The audio of a feed as the relay reports it: undefined when not known (the
 *  feed has not been seen), null when it has no audio track, else the codec's
 *  name as MediaMTX spells it. */
export type RelayAudio = string | null | undefined;

/** What a browser can receive from the relay as it is: WebRTC carries these. */
const DIRECT = new Set(["OPUS", "G711", "G722", "LPCM"]);
/** AAC, which MediaMTX calls MPEG-4 Audio. */
const AAC = new Set(["MPEG4AUDIO", "AAC"]);

export type AudioClass = "aac" | "direct" | "other";

export function classifyAudio(codec: string): AudioClass {
  const n = normalizeCodecName(codec);
  if (DIRECT.has(n)) return "direct";
  if (AAC.has(n)) return "aac";
  return "other";
}

/** Why a feed runs a converter, as the sentence the log line says when it starts. */
export const WHY_AAC = "the feed's audio is AAC";
export const WHY_ALWAYS = "Audio conversion is Always";
export const WHY_PASS_THROUGH = "audio source address, copied as it is";
export const WHY_UNKNOWN = "the feed's audio was not known when it was set up";
export type ConverterWhy = typeof WHY_AAC | typeof WHY_ALWAYS | typeof WHY_PASS_THROUGH | typeof WHY_UNKNOWN;

export interface AudioInput {
  conversion: AudioConversion;
  sourceUrl?: string;
  audio: RelayAudio;
}

export interface AudioPlan {
  status: FeedAudioStatus;
  /** What the feed's `-listen` path would run, or null when it needs none. It
   *  still waits on ffmpeg being usable: see resolveAudio. */
  converter: { mode: "convert"; why: ConverterWhy } | { mode: "pass-through"; url: string; why: typeof WHY_PASS_THROUGH } | null;
}

/**
 * The rule table, as if ffmpeg were available.
 *
 *  - An audio source address, with the conversion not Off: pass-through.
 *  - Off never runs ffmpeg for the feed, address or not.
 *  - A feed known to have no audio track has none to convert.
 *  - A codec browsers receive as it is is read directly, unless the setting is
 *    Always.
 *  - AAC is converted (Auto, Always); with Off it cannot be heard.
 *  - Anything else (MP3, AC-3, ...) is converted only under Always: Auto means
 *    "AAC", and it says so rather than quietly widening.
 *  - A feed not seen yet has no codec to judge. Under Auto or Always its
 *    `-listen` path is made anyway: idle it costs nothing, and the codec decides
 *    which path a listener reads once the feed shows up.
 */
export function planAudio(input: AudioInput, id: string): AudioPlan {
  const { conversion, sourceUrl, audio } = input;
  if (sourceUrl && conversion !== "off") {
    return {
      status: { state: "pass-through", listenPath: listenPathName(id) },
      converter: { mode: "pass-through", url: sourceUrl, why: WHY_PASS_THROUGH },
    };
  }
  if (audio === null) return { status: { state: "none" }, converter: null };
  if (audio === undefined) {
    return {
      status: { state: "unknown" },
      converter: conversion === "off" ? null : { mode: "convert", why: WHY_UNKNOWN },
    };
  }
  const cls = classifyAudio(audio);
  const converted: AudioPlan = {
    status: { state: "converted", listenPath: listenPathName(id) },
    converter: { mode: "convert", why: cls === "aac" ? WHY_AAC : WHY_ALWAYS },
  };
  if (conversion === "always") return converted;
  if (cls === "direct") return { status: { state: "direct", listenPath: id }, converter: null };
  if (conversion === "off") {
    return {
      status: { state: "unavailable", reason: `the audio is ${audio}, which a browser cannot play live, and Audio conversion is Off` },
      converter: null,
    };
  }
  if (cls === "aac") return converted;
  return {
    status: { state: "unavailable", reason: `the audio is ${audio}, which Auto does not convert; set Audio conversion to Always` },
    converter: null,
  };
}

/** What the relay and ffmpeg can do for a `-listen` path right now. */
export type ListenCapability = { ok: true; ffmpegPath: string; rtspPort: number } | { ok: false; reason: string };

/** What each input may open, so an address that slipped past validation (`file:`,
 *  `subfile:`, `tcp://...?listen=1`, `udp://`) cannot be read by ffmpeg. The relay's
 *  own RTSP over TCP needs rtsp, rtp and tcp; an audio source address needs http
 *  or https over tcp or tls. */
export const RELAY_PROTOCOLS = "rtsp,rtp,tcp";
export const PASS_THROUGH_PROTOCOLS = "http,https,tls,tcp";

/** The one ffmpeg command of a `-listen` path, as argv. Every argument after the
 *  program is a fixed flag, a validated feed id or a validated address; the
 *  program itself is checked by quoteForMediaMtx. */
export function listenArgv(
  ffmpegPath: string,
  id: string,
  converter: NonNullable<AudioPlan["converter"]>,
  rtspPort: number,
): string[] {
  const relay = `rtsp://127.0.0.1:${rtspPort}`;
  // -fflags nobuffer, -flags low_delay: hand packets on as they arrive. The small
  // probe: both inputs describe their own codecs, so ffmpeg need not read the
  // default 5 s of media. -nostdin: MediaMTX's child has no terminal. -loglevel
  // warning, -nostats: a line on stderr is a problem, the last one is what the log shows.
  const common = [
    "-hide_banner", "-nostdin", "-nostats", "-loglevel", "warning",
    "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "65536", "-analyzeduration", "500000",
  ];
  const out = ["-f", "rtsp", "-rtsp_transport", "tcp", `${relay}/${listenPathName(id)}`];
  if (converter.mode === "pass-through") {
    return [ffmpegPath, ...common, "-protocol_whitelist", PASS_THROUGH_PROTOCOLS, "-rw_timeout", "10000000", "-i", converter.url, "-c", "copy", ...out];
  }
  return [
    ffmpegPath, ...common,
    "-protocol_whitelist", RELAY_PROTOCOLS, "-rtsp_transport", "tcp", "-i", `${relay}/${id}`,
    "-c:v", "copy", "-c:a", "libopus", "-b:a", "128k", "-application", "lowdelay", "-frame_duration", "20",
    ...out,
  ];
}

/** An argv as the one string MediaMTX's runOnDemand takes. MediaMTX 1.21.1 does
 *  not run a shell: it splits the string with shell quoting rules
 *  (go-shellquote), then expands `$NAME` in every word, then executes the words
 *  directly. So there is nothing to inject into, only two ways to be misread:
 *  a quote or a space moves a word boundary, and a `$` is replaced by an
 *  environment value. Each word goes in single quotes (nothing inside is special
 *  to the split), and a word holding a `'`, a `$` or a control character is
 *  refused rather than escaped, because the expansion has no escape for `$`.
 *  Returns the reason when a word is refused. */
export function quoteForMediaMtx(argv: readonly string[]): { ok: true; command: string } | { ok: false; reason: string } {
  for (const word of argv) {
    // eslint-disable-next-line no-control-regex
    if (/['$\u0000-\u001f\u007f]/.test(word)) return { ok: false, reason: "a path or address holds a character the relay cannot pass on safely" };
  }
  return { ok: true, command: argv.map((w) => `'${w}'`).join(" ") };
}

/**
 * The plan, settled against what the relay and ffmpeg can do. A converter that
 * cannot run turns the status into "unavailable: why" — unless the feed has not
 * been seen yet, where it is not known to need one and stays "unknown".
 * `listenCommand` is set exactly when the feed's `-listen` path should exist.
 */
export function resolveAudio(
  plan: AudioPlan,
  id: string,
  capability: ListenCapability,
): { status: FeedAudioStatus; listenCommand?: string; why?: ConverterWhy } {
  const { converter } = plan;
  if (!converter) return { status: plan.status };
  const speculative = converter.why === WHY_UNKNOWN;
  const fail = (reason: string) => ({ status: speculative ? plan.status : ({ state: "unavailable", reason } as FeedAudioStatus) });
  if (!capability.ok) return fail(capability.reason);
  if (!FEED_ID_PATTERN.test(id) || isReservedFeedId(id)) return fail("the feed's id cannot be used as a relay path");
  // The one choke point for an address: a store restored or edited by hand is not
  // validated on load, and `file:`, `tcp://...?listen=1` or `udp://` must never
  // reach ffmpeg.
  if (converter.mode === "pass-through") {
    const problem = audioSourceUrlProblem(converter.url);
    if (problem) return fail(problem);
  }
  const quoted = quoteForMediaMtx(listenArgv(capability.ffmpegPath, id, converter, capability.rtspPort));
  if (!quoted.ok) return fail(quoted.reason);
  return { status: plan.status, listenCommand: quoted.command, why: converter.why };
}
