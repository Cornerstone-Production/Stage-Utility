#!/usr/bin/env -S npx tsx
// listen-measure.ts — what a feed's `<id>-listen` path costs, measured at the relay.
//
//   npx tsx scripts/listen-measure.ts <relay> <feed-id> [--minutes 30] [--interval 10]
//
// <relay> is the relay's RTSP address: `host:port`, or `rtsp://host:port`. The
// port is the one on the Video feeds page's Advanced card ("RTSP (audio
// conversion)", 8554 unless changed) and the relay listens on it for this
// machine only, so run the tool on the server itself. It reads `<id>` and
// `<id>-listen` from the RELAY, never from the encoder (the Ultra Encodes refuse
// a second viewer), and it opens the feed's own path too, which makes an
// on-demand pull feed dial its device.
//
// What it reports, and how:
//
//   First audio packet on -listen. A small RTSP client of its own, not ffprobe:
//   ffprobe holds every packet until it has probed the streams, which on a
//   2-second keyframe interval is up to 2 seconds of its own. The figure runs from
//   the TCP connect to the first RTP packet on the audio channel, so it contains
//   the relay waiting for the converter to start (MediaMTX holds DESCRIBE until the
//   path is ready). It is cold only if nobody was listening in the last 10 seconds.
//
//   The rest comes from ffprobe reading both paths at once, one line per packet,
//   each stamped with the wall clock when it arrives here. For each stream and each
//   window of --interval seconds, W = the smallest (arrival - timestamp). Delay only
//   ever adds, so the minimum is the path's own latency with its jitter taken out.
//
//   A/V offset inside -listen   W(audio) - W(video), both on -listen. Positive: the
//     sound arrives that much later than the picture it belongs with.
//   Added audio delay           how much later a sound arrives on -listen than the
//     same sound on <id>. The two paths number their timestamps from different
//     origins, so W alone cannot be compared. The VIDEO is copied untouched, so the
//     same frame appears on both paths with an identical checksum: matching them
//     gives the origin shift (pts_listen - pts_source) exactly, and then
//       delay = (W_listen_audio - W_source_audio) + shift.
//     The same pairs give the video's own added delay as a cross-check.
//   Drift                       the two figures above, sampled every window, with
//     their min, max and slope (ms per minute) over the run.
//
// Resolution is about 10 to 20 ms (TCP delivery, a pipe, a Node timer). A claim
// finer than that wants a clap or a tone against the picture, not this.
//
// A reader's first seconds are thrown away (--warmup, 4): ffprobe hands over what it
// buffered while probing in one burst, all stamped at the same instant.

import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import { pathToFileURL } from "node:url";

// ── Pure: arguments ──────────────────────────────────────────────────────────

export interface Args {
  host: string;
  port: number;
  feed: string;
  minutes: number;
  intervalS: number;
  warmupS: number;
  ffprobe: string;
  json: boolean;
}

export const USAGE = "usage: listen-measure.ts <relay host:port> <feed-id> [--minutes 30] [--interval 10] [--warmup 4] [--ffprobe path] [--json]";

/** A feed id as the app makes them (feed-id.ts). A `-listen` id is refused: the tool adds the suffix itself. */
const FEED_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const positional: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") opts.json = true;
    else if (a.startsWith("--")) {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      opts[a.slice(2)] = v;
    } else positional.push(a);
  }
  if (positional.length !== 2) return { error: USAGE };
  const [relay, feed] = positional as [string, string];
  if (!FEED_ID.test(feed)) return { error: `"${feed}" is not a feed id` };
  if (feed.endsWith("-listen")) return { error: `give the feed's own id, not "${feed}": the tool reads both` };
  let host: string;
  let port: number;
  try {
    const u = new URL(relay.includes("://") ? relay : `rtsp://${relay}`);
    host = u.hostname;
    port = u.port ? Number(u.port) : 8554;
  } catch {
    return { error: `"${relay}" is not a host:port` };
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { error: `"${relay}" is not a host:port` };
  const num = (key: string, fallback: number, min: number): number | { error: string } => {
    const raw = opts[key];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : { error: `--${key} must be a number of at least ${min}` };
  };
  const minutes = num("minutes", 30, 0.1);
  const intervalS = num("interval", 10, 1);
  const warmupS = num("warmup", 4, 0);
  for (const v of [minutes, intervalS, warmupS]) if (typeof v === "object") return v;
  return {
    host,
    port,
    feed,
    minutes: minutes as number,
    intervalS: intervalS as number,
    warmupS: warmupS as number,
    ffprobe: typeof opts.ffprobe === "string" ? opts.ffprobe : "ffprobe",
    json: opts.json === true,
  };
}

// ── Pure: the measurements ──────────────────────────────────────────────────

/** One packet as ffprobe read it: its media timestamp and the wall time it reached us, in seconds. */
export interface Packet {
  kind: "audio" | "video";
  /** Decode timestamp, seconds. */
  ts: number;
  /** Seconds since the tool started, when the line arrived. */
  wall: number;
  /** A checksum of the payload, for matching a video frame across two paths. */
  crc?: string;
}

/** ffprobe's `-of compact` line for one packet, or null for anything else (a packet with no timestamp yet included). */
export function parsePacketLine(line: string, wall: number): Packet | null {
  if (!line.startsWith("packet|")) return null;
  const f = new Map<string, string>();
  for (const part of line.split("|").slice(1)) {
    const eq = part.indexOf("=");
    if (eq > 0) f.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const kind = f.get("codec_type");
  if (kind !== "audio" && kind !== "video") return null;
  const ts = Number(f.get("dts_time"));
  if (!Number.isFinite(ts)) return null; // "N/A": before the first RTCP report
  const crc = f.get("data_hash");
  return { kind, ts, wall, ...(crc ? { crc } : {}) };
}

/** The smallest arrival-minus-timestamp over a stream's packets that arrived in [from, to), in seconds; null when none did. */
export function wallOffset(packets: readonly Packet[], kind: Packet["kind"], from: number, to: number): number | null {
  let best: number | null = null;
  for (const p of packets) {
    if (p.kind !== kind || p.wall < from || p.wall >= to) continue;
    const w = p.wall - p.ts;
    if (best === null || w < best) best = w;
  }
  return best;
}

export interface VideoMatch {
  /** Frames seen once on each path with the same checksum. */
  pairs: number;
  /** Median of pts_listen - pts_source, seconds. */
  shift: number;
  /** Median of arrival_listen - arrival_source, seconds: the video's own added delay. */
  videoDelay: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Pairs the video frames both paths carry by checksum. A checksum seen twice on a path (a repeated frame) is ignored; so is anything without one. Null with fewer than `min` pairs. */
export function matchVideo(source: readonly Packet[], listen: readonly Packet[], min = 10): VideoMatch | null {
  const once = (packets: readonly Packet[]): Map<string, Packet> => {
    const seen = new Map<string, Packet>();
    const dup = new Set<string>();
    for (const p of packets) {
      if (p.kind !== "video" || !p.crc) continue;
      if (seen.has(p.crc)) dup.add(p.crc);
      else seen.set(p.crc, p);
    }
    for (const d of dup) seen.delete(d);
    return seen;
  };
  const s = once(source);
  const shifts: number[] = [];
  const delays: number[] = [];
  for (const [crc, l] of once(listen)) {
    const m = s.get(crc);
    if (!m) continue;
    shifts.push(l.ts - m.ts);
    delays.push(l.wall - m.wall);
  }
  if (shifts.length < min) return null;
  return { pairs: shifts.length, shift: median(shifts), videoDelay: median(delays) };
}

export interface Sample {
  /** Seconds into the run at the end of the window. */
  at: number;
  /** W(audio) - W(video) on -listen, ms. */
  avOffsetMs: number;
  /** Added audio delay of -listen over the source, ms. */
  audioDelayMs: number;
  /** The video's own added delay by matched frames, ms. */
  videoDelayMs: number;
  /** The same figure by the minimum-filter method the audio uses: if the two disagree, so does the audio's. */
  videoCheckMs: number;
  pairs: number;
}

/**
 * One window's figures, or null when a stream has no packets in it or no frames
 * could be matched. `shift` comes from every frame so far, not only this window's:
 * it is a constant of the two paths, and a longer sample is steadier.
 */
export function sampleWindow(
  source: readonly Packet[],
  listen: readonly Packet[],
  from: number,
  to: number,
): Sample | null {
  const lA = wallOffset(listen, "audio", from, to);
  const lV = wallOffset(listen, "video", from, to);
  const sA = wallOffset(source, "audio", from, to);
  const sV = wallOffset(source, "video", from, to);
  const match = matchVideo(source, listen);
  if (lA === null || lV === null || sA === null || sV === null || match === null) return null;
  return {
    at: to,
    avOffsetMs: (lA - lV) * 1000,
    audioDelayMs: (lA - sA + match.shift) * 1000,
    videoDelayMs: match.videoDelay * 1000,
    videoCheckMs: (lV - sV + match.shift) * 1000,
    pairs: match.pairs,
  };
}

export interface Series {
  n: number;
  min: number;
  max: number;
  mean: number;
  /** Least-squares slope, ms per minute. */
  slopePerMin: number;
}

export function summarize(points: readonly { at: number; value: number }[]): Series | null {
  const n = points.length;
  if (n === 0) return null;
  const values = points.map((p) => p.value);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let slope = 0;
  if (n > 1) {
    const mt = points.reduce((a, p) => a + p.at, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of points) {
      num += (p.at - mt) * (p.value - mean);
      den += (p.at - mt) ** 2;
    }
    slope = den === 0 ? 0 : (num / den) * 60;
  }
  return { n, min: Math.min(...values), max: Math.max(...values), mean, slopePerMin: slope };
}

// ── RTSP: time to the first audio packet ────────────────────────────────────

export type FirstAudio = { ok: true; totalMs: number; answeredMs: number } | { ok: false; reason: string };

interface RtspResponse {
  status: number;
  headers: Map<string, string>;
  body: string;
}

/**
 * Connects, DESCRIBEs, SETUPs the audio track alone over TCP, PLAYs, and times the
 * first RTP packet on its channel. `answeredMs` is when DESCRIBE came back: for a
 * `-listen` path that is the relay waiting for the converter.
 */
export function timeToFirstAudio(host: string, port: number, path: string, timeoutMs = 30_000): Promise<FirstAudio> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const base = `rtsp://${host}:${port}/${path}`;
    const sock = net.connect({ host, port });
    let buf: Buffer = Buffer.alloc(0);
    let cseq = 0;
    let answeredMs = 0;
    let waiting: ((r: RtspResponse) => void) | null = null;
    let streaming = false;
    let done = false;
    const finish = (r: FirstAudio) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `no audio packet within ${timeoutMs / 1000} s` }), timeoutMs);
    /** `thenStream`: the answer to this request is followed by interleaved RTP, so the very next byte is a frame's. */
    let streamAfter = false;
    const send = (method: string, url: string, headers: string[], thenStream = false): Promise<RtspResponse> =>
      new Promise((res) => {
        waiting = res;
        streamAfter = thenStream;
        sock.write(`${method} ${url} RTSP/1.0\r\nCSeq: ${++cseq}\r\n${headers.join("\r\n")}${headers.length ? "\r\n" : ""}\r\n`);
      });
    const parseResponse = (): RtspResponse | null => {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return null;
      const head = buf.subarray(0, end).toString("latin1").split("\r\n");
      const status = Number(/^RTSP\/1\.0 (\d+)/.exec(head[0] ?? "")?.[1]);
      const headers = new Map<string, string>();
      for (const h of head.slice(1)) {
        const c = h.indexOf(":");
        if (c > 0) headers.set(h.slice(0, c).toLowerCase(), h.slice(c + 1).trim());
      }
      const length = Number(headers.get("content-length") ?? 0);
      if (buf.length < end + 4 + length) return null;
      const body = buf.subarray(end + 4, end + 4 + length).toString("latin1");
      buf = buf.subarray(end + 4 + length);
      return { status, headers, body };
    };
    /** After PLAY: `$`, channel, 2-byte length, payload. The first RTP packet on channel 0 ends the wait. */
    const parseFrames = () => {
      while (buf.length >= 4) {
        if (buf[0] !== 0x24) return finish({ ok: false, reason: "the relay sent something other than interleaved RTP after PLAY" });
        const len = buf.readUInt16BE(2);
        if (buf.length < 4 + len) return;
        const channel = buf[1];
        buf = buf.subarray(4 + len);
        if (channel === 0 && len >= 12) return finish({ ok: true, totalMs: performance.now() - t0, answeredMs });
      }
    };
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (streaming) return parseFrames();
      while (waiting) {
        const r = parseResponse();
        if (!r) return;
        const cb = waiting;
        waiting = null;
        if (streamAfter) streaming = true;
        cb(r);
        if (streaming) return parseFrames();
      }
    });
    sock.on("error", (err) => finish({ ok: false, reason: `${err.message}` }));
    sock.on("close", () => finish({ ok: false, reason: "the relay closed the connection" }));
    sock.on("connect", () => {
      void (async () => {
        const describe = await send("DESCRIBE", base, ["Accept: application/sdp"]);
        answeredMs = performance.now() - t0;
        if (describe.status === 401) return finish({ ok: false, reason: "the relay wants credentials, which this tool does not send" });
        if (describe.status !== 200) return finish({ ok: false, reason: `DESCRIBE answered ${describe.status}` });
        const audio = describe.body.split(/\r?\nm=/).find((s) => s.startsWith("audio") || s.startsWith("m=audio"));
        if (!audio) return finish({ ok: false, reason: "the stream has no audio track" });
        const control = /a=control:(\S+)/.exec(audio)?.[1];
        const contentBase = describe.headers.get("content-base") ?? `${base}/`;
        const trackUrl = !control ? base : control.startsWith("rtsp://") ? control : `${contentBase.endsWith("/") ? contentBase : `${contentBase}/`}${control}`;
        const setup = await send("SETUP", trackUrl, ["Transport: RTP/AVP/TCP;unicast;interleaved=0-1"]);
        if (setup.status !== 200) return finish({ ok: false, reason: `SETUP answered ${setup.status}` });
        const session = setup.headers.get("session")?.split(";")[0];
        const played = await send("PLAY", base, [...(session ? [`Session: ${session}`] : []), "Range: npt=0.000-"], true);
        if (played.status !== 200) return finish({ ok: false, reason: `PLAY answered ${played.status}` });
      })();
    });
  });
}

// ── ffprobe: every packet of one path ───────────────────────────────────────

export interface Reader {
  packets: Packet[];
  /** ffprobe's last stderr line, for a reader that ended. */
  lastError: () => string;
  stop: () => void;
  proc: ChildProcess;
}

export function readPackets(ffprobe: string, url: string, startedAt: number): Reader {
  const proc = spawn(
    ffprobe,
    [
      "-v", "error", "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "4096", "-analyzeduration", "0",
      "-rtsp_transport", "tcp", "-show_packets", "-show_entries", "packet=codec_type,dts_time,data_hash", "-show_data_hash", "CRC32",
      "-of", "compact", url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const packets: Packet[] = [];
  let tail = "";
  let err = "";
  proc.stdout!.on("data", (b: Buffer) => {
    const wall = (performance.now() - startedAt) / 1000;
    const lines = (tail + b.toString("utf8")).split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) {
      const p = parsePacketLine(line, wall);
      if (p) packets.push(p);
    }
  });
  proc.stderr!.on("data", (b: Buffer) => {
    err = b.toString("utf8").trim().split("\n").at(-1) ?? err;
  });
  return { packets, lastError: () => err, stop: () => void proc.kill("SIGKILL"), proc };
}

// ── The run ─────────────────────────────────────────────────────────────────

export interface Report {
  relay: string;
  feed: string;
  startedAt: string;
  minutes: number;
  firstAudio: { listenMs: number | null; listenAnsweredMs: number | null; sourceMs: number | null; note: string };
  matchedFrames: number;
  samples: Sample[];
  avOffsetMs: Series | null;
  audioDelayMs: Series | null;
  videoDelayMs: Series | null;
  problems: string[];
}

const f = (n: number | null | undefined, d = 1): string => (n === null || n === undefined ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}`);
const seriesLine = (s: Series | null): string =>
  s ? `min ${f(s.min)}  max ${f(s.max)}  mean ${f(s.mean)}  slope ${f(s.slopePerMin, 2)} ms/min  (${s.n} windows)` : "no data";

export function formatReport(r: Report): string {
  const lines = [
    `listen-measure  ${r.feed}  relay ${r.relay}  ${r.minutes} min  ${r.startedAt}`,
    "",
    `First audio packet on ${r.feed}-listen : ${r.firstAudio.listenMs === null ? "n/a" : `${r.firstAudio.listenMs.toFixed(0)} ms`}` +
      (r.firstAudio.listenAnsweredMs === null ? "" : ` (DESCRIBE answered after ${r.firstAudio.listenAnsweredMs.toFixed(0)} ms)`),
    `First audio packet on ${r.feed}          : ${r.firstAudio.sourceMs === null ? "n/a" : `${r.firstAudio.sourceMs.toFixed(0)} ms`}`,
    `  ${r.firstAudio.note}`,
    "",
    `Added audio delay, -listen vs source (ms)    : ${seriesLine(r.audioDelayMs)}`,
    `Added video delay, same frames (ms)          : ${seriesLine(r.videoDelayMs)}`,
    `Audio/video offset inside -listen (ms)       : ${seriesLine(r.avOffsetMs)}`,
    `Frames matched between the two paths         : ${r.matchedFrames}`,
  ];
  if (r.problems.length) lines.push("", ...r.problems.map((p) => `PROBLEM: ${p}`));
  return lines.join("\n");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function run(args: Args, log: (line: string) => void = console.log): Promise<Report> {
  const problems: string[] = [];
  const relay = `${args.host}:${args.port}`;
  const listenPath = `${args.feed}-listen`;

  // The cold read first: the converter starts for it, and the readers below find it warm.
  const first = await timeToFirstAudio(args.host, args.port, listenPath);
  if (!first.ok) problems.push(`no first-audio time on ${listenPath}: ${first.reason}`);
  const firstSource = await timeToFirstAudio(args.host, args.port, args.feed);
  if (!firstSource.ok) problems.push(`no first-audio time on ${args.feed}: ${firstSource.reason}`);
  log(`first audio packet: ${listenPath} ${first.ok ? `${first.totalMs.toFixed(0)} ms` : first.reason}, ${args.feed} ${firstSource.ok ? `${firstSource.totalMs.toFixed(0)} ms` : firstSource.reason}`);

  const startedAt = performance.now();
  const source = readPackets(args.ffprobe, `rtsp://${relay}/${args.feed}`, startedAt);
  const listen = readPackets(args.ffprobe, `rtsp://${relay}/${listenPath}`, startedAt);
  const samples: Sample[] = [];
  const total = args.minutes * 60;
  const end = startedAt + total * 1000;
  let windowStart = 0;
  try {
    while (performance.now() < end) {
      const nextEdge = Math.min(windowStart + args.intervalS, total);
      await sleep(Math.max(0, startedAt + nextEdge * 1000 - performance.now()));
      if (source.proc.exitCode !== null || listen.proc.exitCode !== null) {
        problems.push(`ffprobe ended early: ${source.proc.exitCode !== null ? `${args.feed}: ${source.lastError()}` : `${listenPath}: ${listen.lastError()}`}`);
        break;
      }
      const from = Math.max(windowStart, args.warmupS);
      if (nextEdge - from >= Math.min(2, args.intervalS)) {
        const s = sampleWindow(source.packets, listen.packets, from, nextEdge);
        if (s) {
          samples.push(s);
          log(`t=${String(Math.round(nextEdge)).padStart(5)}s  A/V ${f(s.avOffsetMs)} ms  audio delay ${f(s.audioDelayMs)} ms  video delay ${f(s.videoDelayMs)} ms  (${s.pairs} frames)`);
        } else log(`t=${String(Math.round(nextEdge)).padStart(5)}s  no figure: a stream had no packets in the window, or too few frames matched`);
      }
      windowStart = nextEdge;
      // Packets already measured are not needed again; this keeps a 30-minute run's memory flat.
      const keepFrom = windowStart - 60;
      for (const r of [source, listen]) {
        let drop = 0;
        while (drop < r.packets.length && r.packets[drop]!.wall < keepFrom) drop++;
        if (drop > 0) r.packets.splice(0, drop);
      }
    }
  } finally {
    source.stop();
    listen.stop();
  }
  const disagreement = samples.length ? Math.max(...samples.map((s) => Math.abs(s.videoCheckMs - s.videoDelayMs))) : 0;
  if (disagreement > 10) {
    problems.push(`the two ways of measuring the video's added delay disagree by up to ${disagreement.toFixed(0)} ms, so read the audio figure as that much less certain`);
  }
  if (samples.length === 0) problems.push("no window produced a figure: check that both paths carry audio and video and that the feed is live (a pass-through feed's -listen video is another encode, so its frames cannot be matched)");
  return {
    relay,
    feed: args.feed,
    startedAt: new Date().toISOString(),
    minutes: args.minutes,
    firstAudio: {
      listenMs: first.ok ? first.totalMs : null,
      listenAnsweredMs: first.ok ? first.answeredMs : null,
      sourceMs: firstSource.ok ? firstSource.totalMs : null,
      note: "Cold only if nobody had listened in the last 10 seconds; it includes the converter starting.",
    },
    matchedFrames: samples.at(-1)?.pairs ?? 0,
    samples,
    avOffsetMs: summarize(samples.map((s) => ({ at: s.at, value: s.avOffsetMs }))),
    audioDelayMs: summarize(samples.map((s) => ({ at: s.at, value: s.audioDelayMs }))),
    videoDelayMs: summarize(samples.map((s) => ({ at: s.at, value: s.videoDelayMs }))),
    problems,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    process.exit(2);
  }
  const report = await run(args, args.json ? () => {} : console.log);
  console.log(args.json ? JSON.stringify(report, null, 2) : `\n${formatReport(report)}`);
  process.exit(report.problems.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
